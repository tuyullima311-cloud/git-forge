// Git smart HTTP: info/refs advertisements (protocol v0 and v2), v2 ls-refs, v0/v2 fetch
// (upload-pack) with shallow/deepen support, and v0 push (receive-pack) with per-ref
// report-status. Objects move as plain (undeltified) packs; pushes are read with full delta
// resolution (pack.ts). Ref updates apply independently, never atomically, as the suite's
// mixed-push check requires.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isAncestor,
  isOid,
  parseCommit,
  peelToCommit,
  reachableCommits,
  type Forge,
  type Repo,
} from './store.ts';
import { PKT_DELIM, PKT_FLUSH, ingestPack, parsePkts, pktLine, sidebandWrap, writePack } from './pack.ts';

const AGENT = 'forge/1.0';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

// ------------------------------------------------------------------ ref listing

interface RefLine {
  oid: string;
  name: string;
  peeled: string | null;
  symrefTarget: string | null;
  unborn: boolean;
}

/** HEAD plus every ref, git's order: HEAD first, then refs sorted by name, tags peeled inline. */
function listRefs(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTip = repo.refs.get(repo.headRef);
  if (headTip !== undefined) {
    lines.push({ oid: headTip, name: 'HEAD', peeled: null, symrefTarget: repo.headRef, unborn: false });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let peeled: string | null = null;
    const object = forge.store.get(oid);
    if (object !== undefined && object.type === 'tag') peeled = peelToCommit(forge.store, oid);
    lines.push({ oid, name, peeled, symrefTarget: null, unborn: false });
  }
  return lines;
}

// ------------------------------------------------------------------ advertisements

function advertiseV0(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', res: ServerResponse): void {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:${repo.headRef} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = listRefs(forge, repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const line of lines) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
      if (line.peeled !== null) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  send(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

function advertiseV2(res: ServerResponse): void {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow side-band-64k ofs-delta wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  send(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

export function handleInfoRefs(forge: Forge, repo: Repo, service: string | null, protocolHeader: string | undefined, res: ServerResponse): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'missing or unsupported service\n');
    return;
  }
  if (service === 'git-upload-pack' && protocolHeader !== undefined && /(?:^|[, ])version=2/.test(protocolHeader)) {
    advertiseV2(res);
    return;
  }
  advertiseV0(forge, repo, service, res);
}

// ------------------------------------------------------------------ request parsing

interface PktReader {
  lines: string[];
  rest: Buffer;
}

/** Read pkt-line data packets until the first flush; `rest` is whatever follows it. */
function readUntilFlush(body: Buffer): PktReader {
  const { packets, consumed } = parsePkts(body);
  const lines: string[] = [];
  let used = 0;
  let at = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      used = at + 4;
      break;
    }
    if (packet.kind === 'data') {
      lines.push(packet.data.toString('utf8'));
      at += 4 + packet.data.length;
    } else {
      at += 4;
    }
  }
  void consumed;
  return { lines, rest: body.subarray(used === 0 ? body.length : used) };
}

/** Split a v2 command request into its capability lines and argument lines. */
function splitV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = parsePkts(body);
  let command = '';
  const args: string[] = [];
  let phase: 'command' | 'caps' | 'args' = 'command';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      if (phase === 'caps') phase = 'args';
      continue;
    }
    const text = packet.data.toString('utf8').replace(/\n$/, '');
    if (phase === 'command') {
      command = text;
      phase = 'caps';
    } else if (phase === 'args') {
      args.push(text);
    }
  }
  return { command, args };
}

// ------------------------------------------------------------------ ls-refs (v2)

function handleLsRefs(forge: Forge, repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(repo.headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    }
  }
  const lines = listRefs(forge, repo);
  for (const line of lines) {
    if (line.name === 'HEAD') continue;
    if (!matches(line.name)) continue;
    let text = `${line.oid} ${line.name}`;
    if (peel && line.peeled !== null) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ------------------------------------------------------------------ fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function walkWithCut(forge: Forge, tips: string[], cutAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(forge.store, tip);
    if (commit !== null) stack.push(commit);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (cutAt.has(oid)) continue;
    const object = forge.store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return seen;
}

/** Commits within `limit` generations of the roots (a root is generation 1). */
function depthLimited(forge: Forge, roots: string[], limit: number): Set<string> {
  const depthOf = new Map<string, number>();
  let frontier: string[] = [];
  for (const root of roots) {
    const commit = peelToCommit(forge.store, root);
    if (commit !== null && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      frontier.push(commit);
    }
  }
  for (let depth = 1; depth < limit && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = forge.store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return new Set(depthOf.keys());
}

/** Every object (commits, trees, blobs, tags) needed to check out `commits`. */
function objectClosure(forge: Forge, commits: Set<string>, extraRoots: string[]): Set<string> {
  const out = new Set<string>();
  const seenTrees = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (seenTrees.has(treeOid)) return;
    seenTrees.add(treeOid);
    const object = forge.store.get(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    out.add(treeOid);
    const text = object.data;
    let offset = 0;
    while (offset < text.length) {
      const space = text.indexOf(0x20, offset);
      if (space === -1) break;
      const mode = text.toString('utf8', offset, space);
      const nul = text.indexOf(0x00, space + 1);
      if (nul === -1 || nul + 21 > text.length) break;
      const childOid = text.toString('hex', nul + 1, nul + 21);
      if (mode === '40000' || mode === '040000') addTree(childOid);
      else out.add(childOid);
      offset = nul + 21;
    }
  };
  for (const oid of extraRoots) out.add(oid);
  for (const commitOid of commits) {
    out.add(commitOid);
    const object = forge.store.get(commitOid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit !== null) addTree(commit.tree);
  }
  return out;
}

interface FetchPlan {
  sendOids: string[];
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(forge: Forge, request: FetchRequest): FetchPlan {
  const store = forge.store;
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of request.wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraRoots.push(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) wantCommits.push(commit);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      extraRoots.push(want);
    }
  }
  const shallowSet = new Set(request.shallow);
  // What the client already holds: everything reachable from its haves, cut at its
  // shallow boundary (a boundary commit's parents are not held).
  const heldCommits = walkWithCut(forge, request.haves, shallowSet);
  const heldObjects = objectClosure(forge, heldCommits, []);
  // What the client asks for.
  let included: Set<string>;
  if (request.deepen !== null && request.deepenRelative) {
    // Deepen *by* N: everything down to the client's boundary, plus N generations below it.
    included = walkWithCut(forge, wantCommits, shallowSet);
    let frontier = [...shallowSet].filter((oid) => forge.store.has(oid));
    for (let generation = 0; generation < request.deepen && frontier.length > 0; generation += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const object = forge.store.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        if (commit === null) continue;
        for (const parent of commit.parents) {
          if (!included.has(parent)) {
            included.add(parent);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
  } else if (request.deepen !== null) {
    included = depthLimited(forge, wantCommits, request.deepen);
  } else if (request.deepenSince !== null) {
    const all = reachableCommits(store, wantCommits);
    included = new Set<string>();
    for (const oid of all) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit !== null && commit.committerSec >= request.deepenSince) included.add(oid);
    }
  } else {
    included = reachableCommits(store, wantCommits);
  }
  for (const not of request.deepenNot) {
    for (const oid of reachableCommits(store, [not])) included.delete(oid);
  }
  const includedObjects = objectClosure(forge, included, extraRoots);
  const sendOids: string[] = [];
  for (const oid of includedObjects) if (!heldObjects.has(oid)) sendOids.push(oid);
  // The new shallow boundary: included commits with a parent the pack leaves out.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.deepen !== null || request.deepenSince !== null) {
    for (const oid of included) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit === null) continue;
      if (commit.parents.some((parent) => !included.has(parent) && store.has(parent))) shallow.push(oid);
    }
  }
  for (const boundary of request.shallow) {
    if (!included.has(boundary)) continue;
    const object = store.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    const stillBoundary = commit.parents.some((parent) => !included.has(parent) && store.has(parent));
    if (!stillBoundary && !shallow.includes(boundary)) unshallow.push(boundary);
  }
  const commonHaves: string[] = [];
  for (const have of request.haves) {
    const object = store.get(have);
    if (object !== undefined && object.type === 'commit' && !commonHaves.includes(have)) commonHaves.push(have);
  }
  return { sendOids, shallow, unshallow, commonHaves };
}

function fetchSection(lines: string[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

function handleFetchV2(forge: Forge, args: string[], res: ServerResponse): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false };
  let waitForDone = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7).trim()) || null;
    else if (arg === 'deepen-relative') request.deepenRelative = true;
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim()) || null;
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') request.done = true;
    else if (arg === 'wait-for-done') waitForDone = true;
  }
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  const acks: string[] = ['acknowledgments\n'];
  if (plan.commonHaves.length === 0) {
    acks.push('NAK\n');
  } else {
    for (const have of plan.commonHaves) acks.push(`ACK ${have}\n`);
    if (request.done) acks.push('ready\n');
  }
  if (!request.done) {
    // A negotiation round is answered by the acknowledgments section alone.
    parts.push(fetchSection(acks));
    parts.push(PKT_FLUSH);
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  // With `done`, real git servers send no acknowledgments section at all (acknowledgments
  // belong to negotiation rounds and wait-for-done), and shallow-info only when there is
  // shallow news; strict clients (git itself) refuse sections they did not negotiate.
  if (waitForDone) {
    parts.push(fetchSection(acks));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    parts.push(fetchSection(shallowLines));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(forge.store, plan.sendOids);
  parts.push(sidebandWrap(pack, 1));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(forge: Forge, body: Buffer, res: ServerResponse): void {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false };
  const firstToken = (line: string, prefix: string): string => line.slice(prefix.length).split(/[\0 ]/)[0] ?? '';
  const first = readUntilFlush(body);
  for (const line of first.lines) {
    const clean = line.replace(/\n$/, '');
    // The first want line carries its capabilities after a space (v0), not a NUL.
    if (clean.startsWith('want ')) request.wants.push(firstToken(clean, 'want '));
  }
  const second = readUntilFlush(first.rest);
  for (const line of second.lines) {
    const clean = line.replace(/\n$/, '');
    if (clean.startsWith('have ')) request.haves.push(firstToken(clean, 'have '));
    else if (clean.startsWith('shallow ')) request.shallow.push(firstToken(clean, 'shallow '));
    else if (clean.startsWith('deepen ')) request.deepen = Number(clean.slice(7).trim()) || null;
    else if (clean === 'deepen-relative') request.deepenRelative = true;
    else if (clean.startsWith('deepen-since ')) request.deepenSince = Number(clean.slice(13).trim()) || null;
    else if (clean.startsWith('deepen-not ')) request.deepenNot.push(firstToken(clean, 'deepen-not '));
    else if (clean === 'done') request.done = true;
  }
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${plan.commonHaves[0]}\n`));
  const pack = writePack(forge.store, plan.sendOids);
  parts.push(sidebandWrap(pack, 1));
  parts.push(PKT_FLUSH);
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): void {
  void repo;
  // A v2 command request starts with a `command=` line; anything else is a v0 fetch.
  const probe = parsePkts(body.subarray(0, Math.min(body.length, 128)));
  const first = probe.packets[0];
  if (first !== undefined && first.kind === 'data' && first.data.toString('utf8').startsWith('command=')) {
    const { command, args } = splitV2Request(body);
    if (command === 'command=ls-refs') {
      handleLsRefs(forge, repo, args, res);
      return;
    }
    if (command === 'command=fetch') {
      handleFetchV2(forge, args, res);
      return;
    }
    sendText(res, 400, `unknown command\n`);
    return;
  }
  handleFetchV0(forge, body, res);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function validatePush(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const store = forge.store;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(command.ref) || command.ref.includes('..')) return 'invalid ref';
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return 'reference does not exist';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'stale info';
    return null;
  }
  if (!isOid(command.newOid) || !store.has(command.newOid)) return 'invalid object';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined && current !== command.newOid) return 'already exists';
    return null;
  }
  if (current === undefined) return 'reference does not exist';
  if (current !== command.oldOid) return 'stale info';
  if (current === command.newOid) return null;
  const oldCommit = peelToCommit(store, current);
  const newCommit = peelToCommit(store, command.newOid);
  if (oldCommit !== null && newCommit !== null) {
    if (!isAncestor(store, oldCommit, newCommit)) return 'non-fast-forward';
  }
  return null;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines, rest } = readUntilFlush(body);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\0.*$/s, '').replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    commands.push({ oldOid, newOid, ref });
  }
  let unpackLine = 'unpack ok\n';
  let unpackFailed = false;
  if (rest.length > 0) {
    try {
      ingestPack(forge.store, rest);
    } catch (err) {
      unpackFailed = true;
      unpackLine = `unpack ${err instanceof Error ? err.message : 'index-pack failed'}\n`;
    }
  }
  const report: Buffer[] = [pktLine(unpackLine)];
  for (const command of commands) {
    let failure = unpackFailed ? 'unpack failed' : validatePush(forge, repo, command);
    if (failure === null) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    report.push(pktLine(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`));
  }
  report.push(PKT_FLUSH);
  const payload = Buffer.concat(report);
  send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([sidebandWrap(payload, 1), PKT_FLUSH]));
}

/** Route one git smart-HTTP request. `kind` is info/refs, git-upload-pack or git-receive-pack. */
export function handleGitRequest(
  forge: Forge,
  repo: Repo,
  kind: string,
  req: IncomingMessage,
  body: Buffer,
  service: string | null,
  res: ServerResponse,
): void {
  if (kind === 'info/refs') {
    handleInfoRefs(forge, repo, service, req.headers['git-protocol'], res);
    return;
  }
  if (kind === 'git-upload-pack') {
    handleUploadPack(forge, repo, body, res);
    return;
  }
  handleReceivePack(forge, repo, body, res);
}
