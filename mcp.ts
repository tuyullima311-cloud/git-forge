// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over streamable HTTP, speaking both protocol
// eras the suite accepts — the modern one (server/discover, revision 2026-07-28, no session)
// and the handshake era (initialize + notifications/initialized, revisions down to 2024-11-05).
// The six tools are github-mcp-server's core repository tools, executed against the same
// forge the REST and GraphQL surfaces serve, so an object made over MCP is the same object
// over REST (the suite's parity check reads it back both ways).

import type { Forge, Repo } from './store.ts';
import { createIssueIn, createPullIn, issueJson, mergePullIn, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

export interface McpReply {
  status: number;
  /** The JSON body to send; null means an empty body (a notification acknowledgement). */
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown>;
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = argString(args, 'owner');
  const repoName = argString(args, 'repo');
  if (owner === undefined || repoName === undefined) throw new ToolError('owner and repo are required');
  if (owner.toLowerCase() !== forge.viewer.login.toLowerCase()) throw new ToolError(`repository ${owner}/${repoName} not found`);
  const repo = forge.findRepo(repoName);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${repoName} not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = argString(args, 'name');
      if (name === undefined) throw new ToolError('name is required');
      if (forge.findRepo(name) !== undefined) throw new ToolError('name already exists on this account');
      const description = typeof args.description === 'string' ? args.description : '';
      const repo = forge.createRepo(name, args.private === true, description);
      return repoJson(forge, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(forge, requireRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = requireRepo(forge, args);
      const title = argString(args, 'title');
      if (title === undefined) throw new ToolError('title is required');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = createIssueIn(forge, repo, title, body, []);
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = requireRepo(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return { issues: issues.map((issue) => issueJson(forge, repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = requireRepo(forge, args);
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (title === undefined || head === undefined || base === undefined) throw new ToolError('title, head and base are required');
      if (forge.branchTip(repo, head) === null) throw new ToolError(`head branch "${head}" does not exist`);
      if (forge.branchTip(repo, base) === null) throw new ToolError(`base branch "${base}" does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.head === head && pull.base === base) return pullJson(forge, repo, pull);
      }
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = createPullIn(forge, repo, { title, body, head, base });
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
        merge_method: { type: 'string', description: 'The merge method: merge, squash or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = requireRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new ToolError(`pull request not found`);
      const method = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'squash';
      const result = mergePullIn(forge, repo, pull, method);
      if (!result.ok) throw new ToolError('Pull Request is not mergeable');
      return { ...pullJson(forge, repo, pull), sha: result.sha, merged: true };
    },
  },
];

/** tools/list's answer: built once, byte-identical on every call. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function callTool(forge: Forge, id: unknown, params: Record<string, unknown>): McpReply {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return rpcError(id, -32602, `Missing required argument: ${key}`);
    }
  }
  try {
    const result = tool.run(forge, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (err) {
    if (err instanceof ToolError) {
      return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
    }
    throw err;
  }
}

/** Handle one POST /mcp body. `rawBody` is the exact request text. */
export function handleMcp(forge: Forge, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleOne(forge, entry);
      if (reply.body !== null) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  return handleOne(forge, parsed);
}

function handleOne(forge: Forge, message: unknown): McpReply {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const record = message as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id;
  const isNotification = id === undefined;
  const params = (record.params !== null && typeof record.params === 'object' ? record.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call':
      return callTool(forge, id, params);
    default:
      break;
  }
  if (isNotification) return { status: 202, body: null };
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  return rpcError(id, -32601, `Method not found: ${method}`);
}
