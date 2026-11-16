// The REST v3 surface: repositories, branches, commits, contents, labels, issues and pull
// requests, in GitHub's shapes. Handlers are pure functions over the Forge (the HTTP shell in
// app.ts owns auth, body parsing and serialization), so GraphQL and MCP reuse the same merge
// and serialization logic and every surface agrees about the same objects.

import {
  ZERO_OID,
  commitTreeOf,
  diffTrees,
  flattenTree,
  isoOf,
  isAncestor,
  listCommits,
  mergeBase,
  mergeTrees,
  nextTimestamp,
  parseCommit,
  parseTree,
  treeFromFlat,
  type FileChange,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const INSTALLED_VERSION = '1.0.0';

function fail(status: number, message: string): RestReply {
  return { status, body: { message } };
}

export function notFound(): RestReply {
  return fail(404, 'Not Found');
}

// ------------------------------------------------------------------ serialization

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function userJson(forge: Forge, login: string): Record<string, unknown> {
  const known = [forge.identities.viewer, forge.identities.teammate, forge.identities.stranger].find((user) => user.login === login);
  return {
    login,
    id: known?.id ?? 0,
    node_id: globalId('User', String(known?.id ?? 0)),
    avatar_url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: known?.name ?? login,
    email: known?.email ?? '',
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = userJson(forge, forge.viewer.login);
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${forge.viewer.login}/${repo.name}`,
    private: repo.private,
    owner,
    html_url: '',
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.createdSec),
    pushed_at: isoOf(repo.createdSec),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: { name: string; color: string; description: string | null }): Record<string, unknown> {
  let hash = 0;
  for (let i = 0; i < label.name.length; i += 1) hash = (hash * 31 + label.name.charCodeAt(i)) >>> 0;
  return { id: hash, node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  void repo;
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelJson(label ?? { name, color: 'ededed', description: null });
    }),
    user: userJson(forge, issue.authorLogin),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSec) : null,
    html_url: '',
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string; authorLogin: string; createdSec: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(forge, comment.authorLogin),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.createdSec),
    html_url: '',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.head) ?? pull.headSha ?? ZERO_OID;
  const baseSha = forge.branchTip(repo, pull.base) ?? ZERO_OID;
  const refJson = (branch: string, sha: string): Record<string, unknown> => ({
    label: `${forge.viewer.login}:${branch}`,
    ref: branch,
    sha,
    user: userJson(forge, forge.viewer.login),
    repo: repoJson(forge, repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(forge, pull.authorLogin),
    labels: [],
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.mergedSec !== null ? isoOf(pull.mergedSec) : null,
    merged_at: pull.mergedSec !== null ? isoOf(pull.mergedSec) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: refJson(pull.head, headSha),
    base: refJson(pull.base, baseSha),
    merged: pull.merged,
    html_url: '',
  };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> | null {
  const object = forge.store.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  if (commit === null) return null;
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      author: { name: commit.authorName, email: commit.authorEmail, date: isoOf(commit.authorSec) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: isoOf(commit.committerSec) },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: '',
  };
}

// ------------------------------------------------------------------ request helpers

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** The request's Host header, for absolute pagination links. */
  host: string;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(req: RestRequest, all: T[], path: string): Page<T> {
  const perPage = Math.min(100, intParam(req.query, 'per_page', 30));
  const page = intParam(req.query, 'page', 1);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const link = (target: number, rel: string): string => `<http://${req.host}${path}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < lastPage) {
    parts.push(link(page + 1, 'next'));
    parts.push(link(lastPage, 'last'));
  }
  if (page > 1) {
    parts.push(link(1, 'first'));
    parts.push(link(page - 1, 'prev'));
  }
  if (parts.length > 0) headers.link = parts.join(', ');
  return { items, headers };
}

function bodyString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBool(body: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

// ------------------------------------------------------------------ repositories

function createRepo(forge: Forge, req: RestRequest): RestReply {
  const name = bodyString(req.body, 'name');
  if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return fail(422, 'Validation Failed: name is invalid');
  }
  if (forge.findRepo(name) !== undefined) {
    return { status: 422, body: { message: 'Validation Failed: name already exists on this account', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
  }
  const repo = forge.createRepo(name, bodyBool(req.body, 'private') ?? false, bodyString(req.body, 'description') ?? '');
  return { status: 201, body: repoJson(forge, repo) };
}

function patchRepo(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const description = bodyString(req.body, 'description');
  if (description !== undefined) repo.description = description;
  const priv = bodyBool(req.body, 'private');
  if (priv !== undefined) repo.private = priv;
  const defaultBranch = bodyString(req.body, 'default_branch');
  if (defaultBranch !== undefined && defaultBranch !== '') {
    repo.defaultBranch = defaultBranch;
    repo.headRef = `refs/heads/${defaultBranch}`;
  }
  const name = bodyString(req.body, 'name');
  if (name !== undefined && name !== '' && name !== repo.name) {
    forge.repos.delete(forge.repoKey(repo.name));
    repo.name = name;
    forge.repos.set(forge.repoKey(name), repo);
  }
  return { status: 200, body: repoJson(forge, repo) };
}

// ------------------------------------------------------------------ branches and refs

function listBranches(forge: Forge, repo: Repo): RestReply {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false });
  }
  void forge;
  return { status: 200, body: branches };
}

function refObjectJson(forge: Forge, ref: string, oid: string): Record<string, unknown> {
  const object = forge.store.get(oid);
  return { ref, node_id: globalId('Ref', ref), url: '', object: { type: object?.type ?? 'commit', sha: oid, url: '' } };
}

function createRef(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const ref = bodyString(req.body, 'ref');
  const sha = bodyString(req.body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return fail(422, 'Validation Failed: ref and sha are required');
  if (!forge.store.has(sha)) return fail(422, 'Validation Failed: object does not exist');
  if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: refObjectJson(forge, ref, sha) };
}

// ------------------------------------------------------------------ commits

function listCommitsRoute(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const shaParam = req.query.get('sha');
  let tip: string | null = null;
  if (shaParam === null || shaParam === '') {
    tip = repo.refs.get(repo.headRef) ?? null;
  } else if (/^[0-9a-f]{40}$/i.test(shaParam)) {
    tip = forge.store.has(shaParam.toLowerCase()) ? shaParam.toLowerCase() : null;
  } else {
    tip = forge.branchTip(repo, shaParam) ?? repo.refs.get(`refs/tags/${shaParam}`) ?? null;
  }
  if (tip === null) return { status: 200, body: [] };
  const all = listCommits(forge.store, tip)
    .map((oid) => commitJson(forge, oid))
    .filter((entry) => entry !== null);
  const page = paginate(req, all, '');
  return { status: 200, body: page.items, headers: page.headers.link !== undefined ? { link: page.headers.link } : {} };
}

// ------------------------------------------------------------------ contents

/** Resolve a ref parameter (branch, tag, full ref or oid) to a commit oid. */
export function resolveRef(forge: Forge, repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(repo.headRef) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag !== undefined) return byTag;
  const byFull = repo.refs.get(ref);
  if (byFull !== undefined) return byFull;
  if (/^[0-9a-f]{40}$/i.test(ref) && forge.store.has(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

interface TreeWalk {
  kind: 'file' | 'dir' | 'missing';
  blobOid?: string;
  treeOid?: string;
}

function walkTree(forge: Forge, treeOid: string, segments: string[]): TreeWalk {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = forge.store.get(current);
    if (object === undefined || object.type !== 'tree') return { kind: 'missing' };
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return { kind: 'missing' };
    const isLast = i === segments.length - 1;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (isLast) return isDir ? { kind: 'dir', treeOid: entry.oid } : { kind: 'file', blobOid: entry.oid };
    if (!isDir) return { kind: 'missing' };
    current = entry.oid;
  }
  return { kind: 'dir', treeOid: current };
}

function dirListing(forge: Forge, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  void repo;
  const object = forge.store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(object.data)) {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = isDir ? undefined : forge.store.get(entry.oid);
    entries.push({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : (blob?.data.length ?? 0),
      type: isDir ? 'dir' : 'file',
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
    });
  }
  return entries;
}

function getContents(forge: Forge, repo: Repo, path: string, ref: string | undefined): RestReply {
  const tip = resolveRef(forge, repo, ref);
  if (tip === null) return notFound();
  const tree = commitTreeOf(forge.store, tip);
  if (tree === null) return notFound();
  const segments = path === '' ? [] : path.split('/');
  if (segments.length === 0) return { status: 200, body: dirListing(forge, repo, tree, '') };
  const walk = walkTree(forge, tree, segments);
  if (walk.kind === 'missing') return notFound();
  if (walk.kind === 'dir') return { status: 200, body: dirListing(forge, repo, walk.treeOid as string, path) };
  const blob = forge.store.get(walk.blobOid as string);
  if (blob === undefined) return notFound();
  const name = segments[segments.length - 1] as string;
  return {
    status: 200,
    body: {
      name,
      path,
      sha: walk.blobOid,
      size: blob.data.length,
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
    },
  };
}

/** The flat file map a contents write starts from, and the parent commit for it. */
function contentsBase(forge: Forge, repo: Repo, branch: string): { flat: Map<string, { oid: string; mode: string }>; parent: string | null } {
  const tip = forge.branchTip(repo, branch);
  if (tip !== null) {
    const tree = commitTreeOf(forge.store, tip);
    return { flat: tree === null ? new Map() : flattenTree(forge.store, tree), parent: tip };
  }
  // A branch that does not exist yet starts from the default branch (the contents route is
  // one of the two branch-creating routes the suite accepts), or from nothing on a new repo.
  const fallback = repo.refs.get(repo.headRef) ?? null;
  if (fallback !== null) {
    const tree = commitTreeOf(forge.store, fallback);
    return { flat: tree === null ? new Map() : flattenTree(forge.store, tree), parent: fallback };
  }
  return { flat: new Map(), parent: null };
}

function putContents(forge: Forge, repo: Repo, path: string, req: RestRequest): RestReply {
  const content64 = bodyString(req.body, 'content');
  if (content64 === undefined) return fail(422, 'Validation Failed: content is required');
  const message = bodyString(req.body, 'message') ?? `Update ${path}`;
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const bytes = Buffer.from(content64.replace(/\s+/g, ''), 'base64');
  const { flat, parent } = contentsBase(forge, repo, branch);
  const existing = flat.get(path);
  const givenSha = bodyString(req.body, 'sha');
  if (existing !== undefined && givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return fail(409, `${path} does not match ${givenSha}`);
  }
  const blobOid = forge.store.put('blob', bytes);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const tree = treeFromFlat(forge.store, flat);
  const commit = forge.makeCommit(repo, tree, parent === null ? [] : [parent], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  const name = path.split('/').pop() ?? path;
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: { name, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', url: '', html_url: '', git_url: '', download_url: '' },
      commit: { sha: commit, url: '', html_url: '', author: { name: forge.viewer.name, email: forge.viewer.email, date: isoOf(nextTimestamp()) }, committer: { name: forge.viewer.name, email: forge.viewer.email, date: isoOf(nextTimestamp()) }, message, tree: { sha: tree, url: '' }, parents: parent === null ? [] : [{ sha: parent, url: '' }] },
    },
  };
}

function deleteContents(forge: Forge, repo: Repo, path: string, req: RestRequest): RestReply {
  const message = bodyString(req.body, 'message') ?? `Delete ${path}`;
  const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
  const tip = forge.branchTip(repo, branch);
  if (tip === null) return notFound();
  const tree = commitTreeOf(forge.store, tip);
  if (tree === null) return notFound();
  const flat = flattenTree(forge.store, tree);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const givenSha = bodyString(req.body, 'sha');
  if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return fail(409, `${path} does not match ${givenSha}`);
  }
  flat.delete(path);
  const newTree = treeFromFlat(forge.store, flat);
  const commit = forge.makeCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { status: 200, body: { content: null, commit: { sha: commit, url: '', message } } };
}

// ------------------------------------------------------------------ labels

function createLabel(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  void forge;
  const name = bodyString(req.body, 'name');
  if (name === undefined || name === '') return fail(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) return fail(422, 'Validation Failed: name already exists');
  const label = { name, color: (bodyString(req.body, 'color') ?? 'ededed').replace(/^#/, ''), description: bodyString(req.body, 'description') ?? null };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

// ------------------------------------------------------------------ issues

/** The label names a request body names (strings, or {name} objects); null on a bad entry. */
function labelNamesOf(body: Record<string, unknown> | null): string[] | null {
  const raw = body?.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') names.push((entry as Record<string, unknown>).name as string);
    else return null;
  }
  return names;
}

export function createIssueIn(forge: Forge, repo: Repo, title: string, body: string, labelNames: string[]): Issue {
  const sec = nextTimestamp();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: forge.nextIssueId(),
    number,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    authorLogin: forge.viewer.login,
    createdSec: sec,
    updatedSec: sec,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

function createIssue(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const title = bodyString(req.body, 'title');
  if (title === undefined || title === '') return fail(422, 'Validation Failed: title is required');
  const labelNames = labelNamesOf(req.body);
  if (labelNames === null) return fail(422, 'Validation Failed: labels are invalid');
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
  }
  const issue = createIssueIn(forge, repo, title, bodyString(req.body, 'body') ?? '', labelNames);
  return { status: 201, body: issueJson(forge, repo, issue) };
}

function listIssues(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(req, issues, '');
  return { status: 200, body: page.items.map((issue) => issueJson(forge, repo, issue)) };
}

function patchIssue(forge: Forge, repo: Repo, issue: Issue, req: RestRequest): RestReply {
  const state = bodyString(req.body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = bodyString(req.body, 'title');
  if (title !== undefined) issue.title = title;
  const body = bodyString(req.body, 'body');
  if (body !== undefined) issue.body = body;
  const labelNames = labelNamesOf(req.body);
  if (labelNames !== null && req.body?.labels !== undefined) {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
    }
    issue.labels = labelNames;
  }
  issue.updatedSec = nextTimestamp();
  return { status: 200, body: issueJson(forge, repo, issue) };
}

function addComment(forge: Forge, repo: Repo, target: Issue | Pull, req: RestRequest): RestReply {
  const body = bodyString(req.body, 'body');
  if (body === undefined) return fail(422, 'Validation Failed: body is required');
  const comment = { id: forge.nextCommentId(), body, authorLogin: forge.viewer.login, createdSec: nextTimestamp() };
  target.comments.push(comment);
  void repo;
  return { status: 201, body: commentJson(forge, comment) };
}

// ------------------------------------------------------------------ pull requests

export function createPullIn(forge: Forge, repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
  const sec = nextTimestamp();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    id: forge.nextIssueId(),
    number,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    headSha: forge.branchTip(repo, input.head),
    state: 'open',
    merged: false,
    mergedSec: null,
    mergeCommitSha: null,
    authorLogin: forge.viewer.login,
    createdSec: sec,
    updatedSec: sec,
    comments: [],
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Strip an `owner:` label prefix from a head/base value, as GitHub accepts. */
function plainRefName(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function createPull(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const title = bodyString(req.body, 'title');
  const headRaw = bodyString(req.body, 'head');
  const baseRaw = bodyString(req.body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    return fail(422, 'Validation Failed: title, head and base are required');
  }
  const head = plainRefName(headRaw);
  const base = plainRefName(baseRaw);
  if (forge.branchTip(repo, head) === null) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
  if (forge.branchTip(repo, base) === null) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
  if (head === base) return fail(422, 'Validation Failed: head and base are the same');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      return fail(422, `A pull request already exists for ${head} into ${base}`);
    }
  }
  const pull = createPullIn(forge, repo, { title, body: bodyString(req.body, 'body') ?? '', head, base });
  return { status: 201, body: pullJson(forge, repo, pull) };
}

function listPulls(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  const direction = req.query.get('direction') ?? 'desc';
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(req, pulls, '');
  return { status: 200, body: page.items.map((pull) => pullJson(forge, repo, pull)) };
}

/** The changed files of a pull request: the merge-base..head diff. */
export function pullFiles(forge: Forge, repo: Repo, pull: Pull): FileChange[] {
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(forge.store, baseTip, headTip) ?? baseTip;
  const fromTree = commitTreeOf(forge.store, base);
  const toTree = commitTreeOf(forge.store, headTip);
  return diffTrees(forge.store, fromTree, toTree);
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'unmergeable' | 'missing' };

/** Merge a pull request (merge / squash / rebase), updating the base branch on success. */
export function mergePullIn(forge: Forge, repo: Repo, pull: Pull, method: string): MergeResult {
  if (pull.merged) return { ok: false, reason: 'unmergeable' };
  const baseTip = forge.branchTip(repo, pull.base);
  const headTip = forge.branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing' };
  const base = mergeBase(forge.store, baseTip, headTip);
  if (base === null) return { ok: false, reason: 'conflict' };
  if (base === headTip) return { ok: false, reason: 'unmergeable' };
  const merged = mergeTrees(forge.store, commitTreeOf(forge.store, base), commitTreeOf(forge.store, baseTip), commitTreeOf(forge.store, headTip));
  if (merged.conflicts.length > 0) return { ok: false, reason: 'conflict' };
  let sha: string;
  if (method === 'merge') {
    sha = forge.makeCommit(repo, merged.tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`);
  } else if (method === 'rebase' && isAncestor(forge.store, baseTip, headTip)) {
    sha = headTip;
  } else {
    // squash (and the rebase fallback): one commit on the base tip carrying the merged tree.
    const message = pull.body === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
    sha = forge.makeCommit(repo, merged.tree, [baseTip], message);
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSec = nextTimestamp();
  pull.mergeCommitSha = sha;
  pull.updatedSec = pull.mergedSec;
  return { ok: true, sha };
}

function mergePullRoute(forge: Forge, repo: Repo, pull: Pull, req: RestRequest): RestReply {
  const method = (bodyString(req.body, 'merge_method') ?? 'merge').toLowerCase();
  const result = mergePullIn(forge, repo, pull, method);
  if (!result.ok) {
    if (result.reason === 'missing') return notFound();
    return fail(405, 'Pull Request is not mergeable');
  }
  return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ------------------------------------------------------------------ router

function repoRoutes(forge: Forge, repo: Repo, req: RestRequest): RestReply {
  const rest = req.segments.slice(3);
  const [head, second] = rest as [string | undefined, string | undefined];

  if (rest.length === 0) {
    if (req.method === 'GET') return { status: 200, body: repoJson(forge, repo) };
    if (req.method === 'PATCH') return patchRepo(forge, repo, req);
    if (req.method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (head === 'branches') {
    if (rest.length === 1 && req.method === 'GET') return listBranches(forge, repo);
    if (rest.length >= 2 && req.method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === null) return notFound();
      return { status: 200, body: { name: branch, commit: { sha: tip, url: '' }, protected: false } };
    }
    return notFound();
  }

  if (head === 'commits') {
    if (rest.length === 1 && req.method === 'GET') return listCommitsRoute(forge, repo, req);
    if (rest.length === 2 && req.method === 'GET') {
      const commit = commitJson(forge, (second as string).toLowerCase());
      return commit === null ? notFound() : { status: 200, body: commit };
    }
    return notFound();
  }

  if (head === 'git' && second === 'refs') {
    if (rest.length === 2) {
      if (req.method === 'GET') {
        const all = [...repo.refs.entries()].sort().map(([ref, oid]) => refObjectJson(forge, ref, oid));
        return { status: 200, body: all };
      }
      if (req.method === 'POST') return createRef(forge, repo, req);
      return notFound();
    }
    const ref = rest.slice(2).join('/');
    if (req.method === 'GET') {
      const oid = repo.refs.get(ref);
      return oid === undefined ? notFound() : { status: 200, body: refObjectJson(forge, ref, oid) };
    }
    if (req.method === 'DELETE') {
      if (!repo.refs.delete(ref)) return notFound();
      return { status: 204 };
    }
    return notFound();
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (req.method === 'GET') return getContents(forge, repo, path, req.query.get('ref') ?? undefined);
    if (req.method === 'PUT') return putContents(forge, repo, path, req);
    if (req.method === 'DELETE') return deleteContents(forge, repo, path, req);
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (req.method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
      if (req.method === 'POST') return createLabel(forge, repo, req);
      return notFound();
    }
    const label = repo.labels.get(rest.slice(1).join('/'));
    if (label === undefined) return notFound();
    if (req.method === 'GET') return { status: 200, body: labelJson(label) };
    if (req.method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (req.method === 'GET') return listIssues(forge, repo, req);
      if (req.method === 'POST') return createIssue(forge, repo, req);
      return notFound();
    }
    const number = Number(second);
    if (!Number.isInteger(number)) return notFound();
    if (rest.length === 2) {
      const issue = repo.issues.get(number);
      if (req.method === 'GET') {
        if (issue !== undefined) return { status: 200, body: issueJson(forge, repo, issue) };
        const pull = repo.pulls.get(number);
        if (pull !== undefined) {
          // GitHub answers a pull request's number on the issue route too, flagged as a pull.
          const json = pullJson(forge, repo, pull);
          json.pull_request = { url: '', html_url: '', diff_url: '', patch_url: '', merged_at: pull.mergedSec !== null ? isoOf(pull.mergedSec) : null };
          return { status: 200, body: json };
        }
        return notFound();
      }
      if (issue === undefined) return notFound();
      if (req.method === 'PATCH') return patchIssue(forge, repo, issue, req);
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.get(number);
      const pull = repo.pulls.get(number);
      const target = issue ?? pull;
      if (target === undefined) return notFound();
      if (req.method === 'GET') return { status: 200, body: target.comments.map((comment) => commentJson(forge, comment)) };
      if (req.method === 'POST') return addComment(forge, repo, target, req);
      return notFound();
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (req.method === 'GET') return listPulls(forge, repo, req);
      if (req.method === 'POST') return createPull(forge, repo, req);
      return notFound();
    }
    const number = Number(second);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (req.method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
      if (req.method === 'PATCH') {
        const state = bodyString(req.body, 'state');
        if (state === 'open' || state === 'closed') {
          pull.state = state;
          pull.updatedSec = nextTimestamp();
        }
        const title = bodyString(req.body, 'title');
        if (title !== undefined) pull.title = title;
        const body = bodyString(req.body, 'body');
        if (body !== undefined) pull.body = body;
        return { status: 200, body: pullJson(forge, repo, pull) };
      }
      return notFound();
    }
    if (pull === undefined) return notFound();
    if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
      const files = pullFiles(forge, repo, pull).map((change) => ({
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      }));
      return { status: 200, body: files };
    }
    if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') return mergePullRoute(forge, repo, pull, req);
    if (rest.length === 3 && rest[2] === 'comments') {
      if (req.method === 'GET') return { status: 200, body: pull.comments.map((comment) => commentJson(forge, comment)) };
      if (req.method === 'POST') return addComment(forge, repo, pull, req);
      return notFound();
    }
    return notFound();
  }

  return notFound();
}

/** Route one authenticated /api/v3 request. */
export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const segments = req.segments;
  if (segments.length === 0) {
    if (req.method !== 'GET') return notFound();
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1 && req.method === 'GET') {
    return { status: 200, body: { installed_version: INSTALLED_VERSION } };
  }
  if (segments[0] === 'user' && segments.length === 1 && req.method === 'GET') {
    return { status: 200, body: userJson(forge, forge.viewer.login) };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (req.method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const page = paginate(req, all, '/api/v3/user/repos');
      return { status: 200, body: page.items.map((repo) => repoJson(forge, repo)), headers: page.headers };
    }
    if (req.method === 'POST') return createRepo(forge, req);
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    if (owner.toLowerCase() !== forge.viewer.login.toLowerCase()) return notFound();
    const repo = forge.findRepo(name);
    if (repo === undefined) return notFound();
    return repoRoutes(forge, repo, req);
  }
  return notFound();
}
