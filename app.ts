// The HTTP shell: one server, four surfaces. Routing, auth and body handling live here; the
// surfaces themselves are rest.ts (REST v3), gitproto.ts (git smart HTTP), graphql.ts
// (GraphQL v4) and mcp.ts (MCP), all over the one Forge in store.ts.
//
// Auth: the suite's bearer token (MAKEFUN_SHOP_TOKEN) guards REST, GraphQL and MCP — a
// missing or wrong token is a 401 there. The git endpoints take the same token from git
// clients but the suite never tests an unauthenticated git refusal, and real git clients
// vary, so git answers without demanding it. /healthz is open (the env's boot probe).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGitRequest } from './gitproto.ts';
import { handleRest, type RestReply } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

function pathOf(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, searchParams: url.searchParams };
  } catch {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    const header = req.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${token}`;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      requestSeq += 1;
      const requestId = `F${requestSeq.toString(36).toUpperCase().padStart(6, '0')}`;
      const method = req.method ?? 'GET';
      const { pathname, searchParams } = pathOf(req);
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const kind = gitMatch[3] as string;
          const repo = owner.toLowerCase() === forge.viewer.login.toLowerCase() ? forge.findRepo(repoName) : undefined;
          if (repo === undefined) {
            sendBuffer(res, 404, Buffer.from('not found\n'), 'text/plain; charset=utf-8');
            return;
          }
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          handleGitRequest(forge, repo, kind, req, body, searchParams.get('service'), res);
          return;
        }

        // ---- REST v3
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestId });
            return;
          }
          const raw = await readBody(req);
          let body: Record<string, unknown> | null = null;
          if (raw.length > 0) {
            try {
              const parsed: unknown = JSON.parse(raw.toString('utf8'));
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
              return;
            }
          }
          const segments = segmentsOf(pathname.slice('/api/v3'.length));
          const reply: RestReply = handleRest(forge, {
            method,
            segments,
            query: searchParams,
            body,
            host: req.headers.host ?? '127.0.0.1',
          });
          sendJson(res, reply.status, reply.body, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
          return;
        }

        // ---- GraphQL v4
        if (pathname === '/api/graphql' && method === 'POST') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let payload: unknown;
          try {
            payload = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Could not parse the request body as JSON' }] });
            return;
          }
          const reply = executeGraphQL(forge, payload);
          sendJson(res, reply.status, reply.body);
          return;
        }

        // ---- MCP
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          const raw = await readBody(req);
          const reply = handleMcp(forge, raw.toString('utf8'));
          if (reply.body === null) {
            res.writeHead(reply.status);
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        // A malformed request must never take the process down (the suite probes exactly that).
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          if (pathname.startsWith('/api/')) sendJson(res, 500, { message: 'Internal Error' }, { 'x-github-request-id': requestId });
          else sendBuffer(res, 500, Buffer.from('internal error\n'), 'text/plain; charset=utf-8');
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
  return server;
}
