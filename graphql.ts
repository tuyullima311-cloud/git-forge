// GraphQL v4, hand-rolled: a tokenizer and parser for the document subset gh and
// github-mcp-server send (operations with variable definitions, aliases, arguments with
// inline enums/lists/input objects, inline and named fragments), and an executor over the
// forge's own resolvers. No library: the surface the suite probes is small and fixed, and a
// hand executor keeps unknown-field errors, batching and Relay node ids exactly as checked.

import {
  isoOf,
  mergeBase,
  commitTreeOf,
  mergeTrees,
  nextTimestamp,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { commentJson, createIssueIn, createPullIn, globalId, mergePullIn, pullFiles } from './rest.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const value = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc ?? ''] ?? esc ?? '';
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      const text = match?.[0] ?? '0';
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = match?.[0] ?? '';
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ AST and parser

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] }
  | { kind: 'variable'; name: string };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  tokens: Token[];
  at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.at] as Token;
  }

  next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const word = this.expectName();
      if (word === 'query' || word === 'mutation' || word === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().kind === 'punct') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: word === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (word === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${word}"`);
      }
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): void {
    if (!this.skipPunct('(')) return;
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      selections.push(this.parseField());
    }
    return selections;
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      for (const [key, value] of this.parseArguments()) args.set(key, value);
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseArguments(): [string, ValueNode][] {
    this.expectPunct('(');
    const args: [string, ValueNode][] = [];
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    return args;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

/** A ValueNode with variables substituted, as plain JSON data. */
export function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    case 'variable':
      return variables[node.name];
  }
}

// ------------------------------------------------------------------ schema surface

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'prefix', 'repository'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'url', 'author', 'repository',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Commit: ['id', 'oid', 'message'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'isDeprecated', 'deprecationReason', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  State: ['OPEN', 'CLOSED'],
};

// ------------------------------------------------------------------ value wrappers

type Wrapped =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; repo: Repo; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueComment'; repo: Repo; number: number; comment: { id: number; body: string; authorLogin: string; createdSec: number } }
  | { __typename: 'Connection'; flavor: 'issues' | 'pulls' | 'files'; items: Wrapped[]; totalCount: number }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'Edge'; node: Wrapped; cursor: string }
  | { __typename: 'Payload'; payloadType: string; value: Wrapped | null; subject?: Wrapped | null }
  | { __typename: 'CommitRef'; oid: string }
  | { __typename: 'TypeInfo'; name: string }
  | { __typename: 'SchemaInfo' };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  document: DocumentNode;
  errors: { message: string; path?: (string | number)[] }[];
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface PageSlice<T> {
  page: T[];
  startIndex: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginateItems<T>(items: T[], args: Map<string, ValueNode>, ctx: ExecContext): PageSlice<T> {
  const firstRaw = args.has('first') ? valueOf(args.get('first') as ValueNode, ctx.variables) : undefined;
  const first = typeof firstRaw === 'number' ? Math.max(0, Math.trunc(firstRaw)) : items.length;
  const afterRaw = args.has('after') ? valueOf(args.get('after') as ValueNode, ctx.variables) : undefined;
  const afterIndex = afterRaw === null || afterRaw === undefined ? -1 : indexOfCursor(afterRaw);
  const startIndex = afterIndex + 1;
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < items.length;
  return {
    page,
    startIndex,
    hasNextPage,
    endCursor: page.length > 0 ? cursorOf(startIndex + page.length - 1) : afterRaw !== null && afterRaw !== undefined ? String(afterRaw) : null,
    startCursor: page.length > 0 ? cursorOf(startIndex) : null,
  };
}

// ------------------------------------------------------------------ ids

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoByDatabaseId(forge: Forge, databaseId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

function nodeByGlobalId(forge: Forge, id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = repoByDatabaseId(forge, Number(decoded.key));
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map(Number);
    const repo = repoId === undefined ? undefined : repoByDatabaseId(forge, repoId);
    if (repo === undefined || number === undefined) return null;
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { __typename: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  }
  if (decoded.type === 'User') return { __typename: 'User', login: forge.viewer.login };
  return null;
}

// ------------------------------------------------------------------ resolvers

function argsOf(field: FieldNode, ctx: ExecContext): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [name, node] of field.args) out.set(name, valueOf(node, ctx.variables));
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(forge: Forge, repo: Repo, pull: Pull): string {
  const baseTip = forge.branchTip(repo, pull.base);
  const headTip = forge.branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = mergeBase(forge.store, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  const outcome = mergeTrees(forge.store, commitTreeOf(forge.store, base), commitTreeOf(forge.store, baseTip), commitTreeOf(forge.store, headTip));
  return outcome.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const spec = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>) : {}) as Record<string, unknown>;
  const field = typeof spec.field === 'string' ? spec.field : 'CREATED_AT';
  const direction = typeof spec.direction === 'string' ? spec.direction : 'DESC';
  const key = (issue: Issue): number => (field === 'UPDATED_AT' ? issue.updatedSec : field === 'COMMENTS' ? issue.comments.length : issue.createdSec);
  const sorted = [...issues].sort((a, b) => {
    const byKey = key(a) - key(b);
    if (byKey !== 0) return byKey;
    return a.number - b.number;
  });
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

function resolveRepositoryField(ctx: ExecContext, repo: Repo, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  switch (field.name) {
    case 'id':
      return globalId('Repository', String(repo.id));
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${forge.viewer.login}/${repo.name}`;
    case 'owner':
      return { __typename: 'User', login: forge.viewer.login } satisfies Wrapped;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'url':
      return '';
    case 'defaultBranchRef': {
      const tip = forge.branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', repo, name: repo.defaultBranch } satisfies Wrapped;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
    case 'hasPullRequestsEnabled':
      return true;
    case 'createdAt':
    case 'updatedAt':
      return isoOf(repo.createdSec);
    case 'stargazerCount':
    case 'forkCount':
      return 0;
    case 'issue': {
      const number = Number(args.get('number'));
      const issue = repo.issues.get(number);
      return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } satisfies Wrapped);
    }
    case 'pullRequest': {
      const number = Number(args.get('number'));
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } satisfies Wrapped);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const sorted = sortIssues(issues, args.get('orderBy'));
      const wrapped = sorted.map((issue) => ({ __typename: 'Issue', repo, issue }) as Wrapped);
      return { __typename: 'Connection', flavor: 'issues', items: wrapped, totalCount: wrapped.length } satisfies Wrapped;
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => a.number - b.number);
      const wrapped = pulls.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as Wrapped);
      return { __typename: 'Connection', flavor: 'pulls', items: wrapped, totalCount: wrapped.length } satisfies Wrapped;
    }
    default:
      return undefined;
  }
}

function resolveField(ctx: ExecContext, typename: string, source: unknown, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  if (typename === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { __typename: 'User', login: forge.viewer.login } satisfies Wrapped;
      case 'repository': {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        if (owner.toLowerCase() !== forge.viewer.login.toLowerCase()) return null;
        const repo = forge.findRepo(name);
        return repo === undefined ? null : ({ __typename: 'Repository', repo } satisfies Wrapped);
      }
      case 'node': {
        const id = args.get('id');
        return typeof id === 'string' ? nodeByGlobalId(forge, id) : null;
      }
      case '__type': {
        const name = String(args.get('name') ?? '');
        if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) return { __typename: 'TypeInfo', name } satisfies Wrapped;
        return null;
      }
      case '__schema':
        return { __typename: 'SchemaInfo' } satisfies Wrapped;
      case 'rateLimit':
        return null;
      default:
        return undefined;
    }
  }
  if (typename === 'Mutation') return resolveMutationField(ctx, field);
  const wrapped = source as Wrapped;
  switch (wrapped.__typename) {
    case 'User': {
      const user = [forge.identities.viewer, forge.identities.teammate, forge.identities.stranger].find((entry) => entry.login === wrapped.login);
      switch (field.name) {
        case 'id':
          return globalId('User', String(user?.id ?? 0));
        case 'login':
          return wrapped.login;
        case 'name':
          return user?.name ?? wrapped.login;
        case 'email':
          return user?.email ?? '';
        case 'url':
        case 'avatarUrl':
          return '';
        default:
          return undefined;
      }
    }
    case 'Repository':
      return resolveRepositoryField(ctx, wrapped.repo, field);
    case 'Ref':
      switch (field.name) {
        case 'name':
          return wrapped.name;
        case 'prefix':
          return 'refs/heads/';
        case 'repository':
          return { __typename: 'Repository', repo: wrapped.repo } satisfies Wrapped;
        default:
          return undefined;
      }
    case 'Issue': {
      const { issue, repo } = wrapped;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'url':
          return '';
        case 'author':
          return { __typename: 'User', login: issue.authorLogin } satisfies Wrapped;
        case 'repository':
          return { __typename: 'Repository', repo } satisfies Wrapped;
        case 'createdAt':
          return isoOf(issue.createdSec);
        case 'updatedAt':
          return isoOf(issue.updatedSec);
        case 'closedAt':
          return issue.state === 'closed' ? isoOf(issue.updatedSec) : null;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const { pull, repo } = wrapped;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(forge, repo, pull);
        case 'url':
          return '';
        case 'author':
          return { __typename: 'User', login: pull.authorLogin } satisfies Wrapped;
        case 'repository':
          return { __typename: 'Repository', repo } satisfies Wrapped;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'headRefOid':
          return forge.branchTip(repo, pull.head) ?? pull.headSha ?? '';
        case 'baseRefOid':
          return forge.branchTip(repo, pull.base) ?? '';
        case 'createdAt':
          return isoOf(pull.createdSec);
        case 'updatedAt':
          return isoOf(pull.updatedSec);
        case 'mergedAt':
          return pull.mergedSec !== null ? isoOf(pull.mergedSec) : null;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : ({ __typename: 'CommitRef', oid: pull.mergeCommitSha } satisfies Wrapped);
        case 'files': {
          const changes = pullFiles(forge, repo, pull);
          const items = changes.map(
            (change) =>
              ({
                __typename: 'PullRequestChangedFile',
                repo,
                pull,
                path: change.path,
                additions: change.additions,
                deletions: change.deletions,
              }) as unknown as Wrapped,
          );
          return { __typename: 'Connection', flavor: 'files', items, totalCount: items.length } satisfies Wrapped;
        }
        default:
          return undefined;
      }
    }
    case 'IssueComment': {
      const comment = wrapped.comment;
      switch (field.name) {
        case 'id':
          return globalId('IssueComment', String(comment.id));
        case 'body':
          return comment.body;
        case 'author':
          return { __typename: 'User', login: comment.authorLogin } satisfies Wrapped;
        case 'createdAt':
        case 'updatedAt':
          return isoOf(comment.createdSec);
        case 'url':
          return '';
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

// Files in a pull request are resolved through a duck-typed wrapper above; handle them here.
function resolveFileField(source: unknown, field: FieldNode): unknown {
  const file = source as { path: string; additions: number; deletions: number };
  switch (field.name) {
    case 'path':
      return file.path;
    case 'additions':
      return file.additions;
    case 'deletions':
      return file.deletions;
    default:
      return undefined;
  }
}

function resolveMutationField(ctx: ExecContext, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? repoByDatabaseId(forge, Number(decoded.key)) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssueIn(forge, repo, title, body, []);
      return { __typename: 'Payload', payloadType: 'CreateIssuePayload', value: { __typename: 'Issue', repo, issue } } satisfies Wrapped;
    }
    case 'closeIssue': {
      const target = typeof input.issueId === 'string' ? nodeByGlobalId(forge, input.issueId) : null;
      if (target === null || target.__typename !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return null;
      }
      target.issue.state = 'closed';
      target.issue.updatedSec = nextTimestamp();
      return { __typename: 'Payload', payloadType: 'CloseIssuePayload', value: target } satisfies Wrapped;
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? repoByDatabaseId(forge, Number(decoded.key)) : undefined;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo === undefined || forge.branchTip(repo, head) === null || forge.branchTip(repo, base) === null) {
        ctx.errors.push({ message: 'Could not create the pull request: a ref does not exist' });
        return null;
      }
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.head === head && pull.base === base) {
          return { __typename: 'Payload', payloadType: 'CreatePullRequestPayload', value: { __typename: 'PullRequest', repo, pull } } satisfies Wrapped;
        }
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pull = createPullIn(forge, repo, { title, body, head, base });
      return { __typename: 'Payload', payloadType: 'CreatePullRequestPayload', value: { __typename: 'PullRequest', repo, pull } } satisfies Wrapped;
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? nodeByGlobalId(forge, input.pullRequestId) : null;
      if (target === null || target.__typename !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return null;
      }
      const method = (typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE').toLowerCase();
      const repo = repoByDatabaseId(forge, target.repo.id);
      if (repo === undefined) return null;
      const result = mergePullIn(forge, repo, target.pull, method);
      if (!result.ok) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return null;
      }
      return { __typename: 'Payload', payloadType: 'MergePullRequestPayload', value: target } satisfies Wrapped;
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? nodeByGlobalId(forge, input.subjectId) : null;
      if (target === null || (target.__typename !== 'Issue' && target.__typename !== 'PullRequest')) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const holder = target.__typename === 'Issue' ? target.issue : target.pull;
      const comment = { id: forge.nextCommentId(), body, authorLogin: forge.viewer.login, createdSec: nextTimestamp() };
      holder.comments.push(comment);
      const wrapped = { __typename: 'IssueComment', repo: target.repo, number: holder.number, comment } satisfies Wrapped;
      return { __typename: 'Payload', payloadType: 'AddCommentPayload', value: wrapped, subject: target } satisfies Wrapped;
    }
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ executor

function isWrapped(value: unknown): value is Wrapped {
  return value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>);
}

function executeSelectionSet(ctx: ExecContext, typename: string, source: unknown, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      out[key] = executeField(ctx, typename, source, selection, [...path, key]);
    } else if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      const applies =
        condition === null ||
        condition === typename ||
        (isWrapped(source) && source.__typename === condition) ||
        condition === 'Node';
      if (applies) {
        const innerType = condition !== null && condition !== 'Node' && isWrapped(source) && source.__typename === condition ? condition : typename;
        Object.assign(out, executeSelectionSet(ctx, innerType, source, selection.selectionSet, path));
      }
    } else {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment !== undefined) {
        const condition = fragment.typeCondition;
        const applies = condition === null || condition === typename || (isWrapped(source) && source.__typename === condition) || condition === 'Node';
        if (applies) Object.assign(out, executeSelectionSet(ctx, typename, source, fragment.selectionSet, path));
      }
    }
  }
  return out;
}

function executeField(ctx: ExecContext, typename: string, source: unknown, field: FieldNode, path: (string | number)[]): unknown {
  // Introspection meta-fields are valid on every object type.
  if (field.name === '__typename') return typename;
  if ((field.name === '__type' || field.name === '__schema') && typename !== 'Query') {
    return executeField(ctx, 'Query', null, field, path);
  }
  const declared = TYPE_FIELDS[typename];
  const isFileWrapper = isWrapped(source) && (source as { __typename: string }).__typename === 'PullRequestChangedFile';
  if (!isFileWrapper && declared !== undefined && !declared.includes(field.name)) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'`, path });
    return null;
  }
  let value: unknown;
  if (typename === '__Type') {
    value = resolveTypeField(ctx, source, field);
  } else if (typename === '__Field') {
    value = field.name === 'name' ? (source as { name: string }).name : null;
  } else if (typename === '__EnumValue') {
    value = field.name === 'name' ? (source as { name: string }).name : null;
  } else if (typename === '__Schema') {
    value = resolveSchemaField(ctx, field);
  } else if (isFileWrapper) {
    value = resolveFileField(source, field);
  } else if (isWrapped(source) && source.__typename === 'Connection') {
    value = resolveConnectionField(ctx, source, field);
  } else if (isWrapped(source) && source.__typename === 'PageInfo') {
    value = field.name === 'hasNextPage' ? source.hasNextPage : field.name === 'hasPreviousPage' ? false : field.name === 'endCursor' ? source.endCursor : field.name === 'startCursor' ? source.startCursor : undefined;
  } else if (isWrapped(source) && source.__typename === 'Edge') {
    value = field.name === 'node' ? source.node : field.name === 'cursor' ? source.cursor : undefined;
  } else if (isWrapped(source) && source.__typename === 'Payload') {
    if (field.name === 'clientMutationId') value = null;
    else if (field.name === 'commentEdge') value = { __typename: 'Edge', node: source.value as Wrapped, cursor: cursorOf(0) };
    else if (field.name === 'subject') value = source.subject ?? null;
    else value = source.value;
  } else if (isWrapped(source) && source.__typename === 'CommitRef') {
    value = field.name === 'oid' || field.name === 'id' ? source.oid : field.name === 'message' ? '' : undefined;
  } else {
    value = resolveField(ctx, typename, source, field);
  }
  if (value === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typename}'`, path });
    return null;
  }
  return completeValue(ctx, value, field, path);
}

function resolveTypeField(ctx: ExecContext, source: unknown, field: FieldNode): unknown {
  void ctx;
  const info = source as { __typename: 'TypeInfo'; name: string };
  const name = info.name;
  switch (field.name) {
    case 'name':
      return name;
    case 'kind':
      return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    case 'description':
      return null;
    case 'fields':
      return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    case 'enumValues':
      return (ENUM_VALUES[name] ?? []).map((valueName) => ({ __typename: '__EnumValue', name: valueName }));
    case 'possibleTypes':
      return [];
    case 'inputFields':
      return [];
    case 'ofType':
      return null;
    case 'specifiedByURL':
      return null;
    default:
      return undefined;
  }
}

function resolveSchemaField(ctx: ExecContext, field: FieldNode): unknown {
  void ctx;
  switch (field.name) {
    case 'queryType':
      return { __typename: 'TypeInfo', name: 'Query' };
    case 'mutationType':
      return { __typename: 'TypeInfo', name: 'Mutation' };
    case 'subscriptionType':
      return null;
    case 'types':
      return Object.keys(TYPE_FIELDS).map((name) => ({ __typename: 'TypeInfo', name }));
    case 'directives':
      return [];
    default:
      return undefined;
  }
}

function resolveConnectionField(ctx: ExecContext, source: Extract<Wrapped, { __typename: 'Connection' }>, field: FieldNode): unknown {
  // The connection's items were fully materialized by the parent resolver; the first/after
  // arguments live on the connection field itself, so slicing happens in completeValue via a
  // side channel: the parent stored the page on the wrapper. To keep it simple, connections
  // are sliced where they are created — see executeField's caller in completeValue.
  void ctx;
  switch (field.name) {
    case 'nodes':
      return source.items;
    case 'edges':
      return source.items.map((node, index) => ({ __typename: 'Edge', node, cursor: cursorOf(index) }));
    case 'totalCount':
      return source.totalCount;
    case 'pageInfo':
      return { __typename: 'PageInfo', hasNextPage: false, endCursor: source.items.length > 0 ? cursorOf(source.items.length - 1) : null, startCursor: source.items.length > 0 ? cursorOf(0) : null } satisfies Wrapped;
    default:
      return undefined;
  }
}

function typenameOf(value: unknown): string {
  if (isWrapped(value)) {
    if (value.__typename === 'Connection') {
      return value.flavor === 'issues' ? 'IssueConnection' : value.flavor === 'pulls' ? 'PullRequestConnection' : 'PullRequestChangedFileConnection';
    }
    if (value.__typename === 'Payload') return value.payloadType;
    if (value.__typename === 'TypeInfo') return '__Type';
    if (value.__typename === 'SchemaInfo') return '__Schema';
    if (value.__typename === 'CommitRef') return 'Commit';
    return value.__typename;
  }
  return 'Unknown';
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(ctx, item, field, [...path, index]));
  }
  if (isWrapped(value)) {
    // Connections are paginated by the arguments of the field that produced them.
    if (value.__typename === 'Connection' && field.selectionSet !== null) {
      const slice = paginateItems(value.items, field.args, ctx);
      const paged: Wrapped = { __typename: 'Connection', flavor: value.flavor, items: slice.page, totalCount: value.totalCount };
      const out = executeSelectionSet(ctx, typenameOf(paged), paged, field.selectionSet, path);
      // pageInfo must reflect the slice, so resolve it against the slice metadata.
      if ('pageInfo' in out) {
        const info: Wrapped = { __typename: 'PageInfo', hasNextPage: slice.hasNextPage, endCursor: slice.endCursor, startCursor: slice.startCursor };
        const pageInfoField = field.selectionSet.find((entry) => entry.kind === 'field' && entry.name === 'pageInfo') as FieldNode | undefined;
        if (pageInfoField !== undefined && pageInfoField.selectionSet !== null) {
          out[pageInfoField.alias ?? 'pageInfo'] = executeSelectionSet(ctx, 'PageInfo', info, pageInfoField.selectionSet, [...path, 'pageInfo']);
        }
      }
      if ('edges' in out) {
        const edges = slice.page.map((node, index) => ({ __typename: 'Edge', node, cursor: cursorOf(slice.startIndex + index) }) as Wrapped);
        const edgeField = field.selectionSet.find((entry) => entry.kind === 'field' && entry.name === 'edges') as FieldNode | undefined;
        if (edgeField !== undefined) out[edgeField.alias ?? 'edges'] = completeValue(ctx, edges, edgeField, [...path, 'edges']);
      }
      if ('nodes' in out) {
        const nodeField = field.selectionSet.find((entry) => entry.kind === 'field' && entry.name === 'nodes') as FieldNode | undefined;
        if (nodeField !== undefined) out[nodeField.alias ?? 'nodes'] = completeValue(ctx, slice.page, nodeField, [...path, 'nodes']);
      }
      return out;
    }
    if (field.selectionSet !== null) {
      return executeSelectionSet(ctx, typenameOf(value), value, field.selectionSet, path);
    }
    return value;
  }
  return value;
}

// ------------------------------------------------------------------ entry point

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one operation document (or a batch) against the forge. */
export function executeGraphQL(forge: Forge, payload: unknown): GraphQLReply {
  if (Array.isArray(payload)) {
    const results = payload.map((entry) => executeOne(forge, entry));
    return { status: 200, body: results.map((result) => result.body) };
  }
  return executeOne(forge, payload);
}

function executeOne(forge: Forge, payload: unknown): GraphQLReply {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { errors: [{ message: 'Expected a JSON object with a query' }] } };
  }
  const record = payload as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query === '') {
    return { status: 400, body: { errors: [{ message: 'Expected a query string' }] } };
  }
  const variables = (record.variables !== null && typeof record.variables === 'object' ? record.variables : {}) as Record<string, unknown>;
  let document: DocumentNode;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query' }] } };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) {
    return { status: 200, body: { errors: [{ message: 'No operation found' }] } };
  }
  const ctx: ExecContext = { forge, variables, document, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}
