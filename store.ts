// The forge's store: one content-addressed git object store shared by every repository, plus
// the per-repository state (refs, labels, issues, pull requests) the REST/GraphQL/MCP surfaces
// share. Everything lives in memory: a trial is one process on a fresh forge, and in-memory
// maps are what make the timed workloads fast. All timestamps the forge itself mints come from
// a logical clock (a fixed epoch plus a counter), so behavior is deterministic per run.

import { createHash } from 'node:crypto';
import { scenarioIdentities, type ScenarioUser } from './scenario.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a typed payload: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ------------------------------------------------------------------ logical clock

const CLOCK_EPOCH_SEC = 1_700_000_000;
let clockTick = 0;

/** The next deterministic timestamp (seconds since the epoch). */
export function nextTimestamp(): number {
  clockTick += 1;
  return CLOCK_EPOCH_SEC + clockTick;
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

// ------------------------------------------------------------------ object store

export class ObjectStore {
  objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ------------------------------------------------------------------ commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorSec: number;
  committerName: string;
  committerEmail: string;
  committerSec: number;
  message: string;
}

const IDENT_LINE = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/;

export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: RegExpMatchArray | null = null;
  let committer: RegExpMatchArray | null = null;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7).match(IDENT_LINE);
    else if (line.startsWith('committer ')) committer = line.slice(10).match(IDENT_LINE);
  }
  if (tree === '') return null;
  return {
    tree,
    parents,
    authorName: author?.[1] ?? '',
    authorEmail: author?.[2] ?? '',
    authorSec: author?.[3] !== undefined ? Number(author[3]) : 0,
    committerName: committer?.[1] ?? '',
    committerEmail: committer?.[2] ?? '',
    committerSec: committer?.[3] !== undefined ? Number(committer[3]) : 0,
    message,
  };
}

export function buildCommitData(input: {
  tree: string;
  parents: string[];
  message: string;
  name: string;
  email: string;
  sec: number;
}): Buffer {
  const ident = `${input.name} <${input.email}> ${input.sec} +0000`;
  let head = `tree ${input.tree}\n`;
  for (const parent of input.parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n`;
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${head}\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree order: by name, directories sorting as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (blob) under a tree, as a flat path -> {oid, mode} map. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob map; answers the root tree oid. */
export function treeFromFlat(store: ObjectStore, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTreeData(entries));
  };
  return build(root);
}

/** The tree oid of a commit (or of a tag's target commit), or null. */
export function commitTreeOf(store: ObjectStore, oid: string): string | null {
  const peeled = peelToCommit(store, oid);
  if (peeled === null) return null;
  const object = store.get(peeled);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return commit === null ? null : commit.tree;
}

/** Follow tag objects to the commit they name; a commit peels to itself; anything else null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null || match[1] === undefined) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a tag object names (its direct target), for `^{}` peel lines. */
export function tagTarget(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match === null || match[1] === undefined ? null : match[1];
}

// ------------------------------------------------------------------ history walks

/** All commits reachable from `tip` (inclusive), parents followed, no duplicates. */
export function reachableCommits(store: ObjectStore, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (commit !== null) stack.push(commit);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(store, [descendant]).has(ancestor);
}

/** A best common ancestor of two commits (BFS from both sides), or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = reachableCommits(store, [a]);
  if (ancestorsA.has(b)) return b;
  const ancestorsB = reachableCommits(store, [b]);
  if (ancestorsB.has(a)) return a;
  // BFS from b, first commit that is also an ancestor of a wins (nearest to b).
  const seen = new Set<string>([b]);
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Commits reachable from `tip`, newest first (DFS pre-order, parents in order). */
export function listCommits(store: ObjectStore, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    seen.add(oid);
    out.push(oid);
    const commit = parseCommit(object.data);
    if (commit === null) return;
    for (const parent of commit.parents) visit(parent);
  };
  const start = peelToCommit(store, tip);
  if (start !== null) visit(start);
  return out;
}

// ------------------------------------------------------------------ diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a text diff (LCS over lines; files in this forge are small). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop the shared trailing empty element split() leaves for a final newline.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    // Very large files: fall back to a whole-file count rather than an LCS table.
    return { additions: m, deletions: n };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = oldLines[i] === newLines[j] ? (dp[(i + 1) * (m + 1) + j + 1] as number) + 1 : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: m - common, deletions: n - common };
}

function blobText(store: ObjectStore, oid: string | null): string {
  if (oid === null) return '';
  const object = store.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** The per-path diff between two trees (either may be null for an empty tree). */
export function diffTrees(store: ObjectStore, oldTree: string | null, newTree: string | null): FileChange[] {
  const oldFlat = oldTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, oldTree);
  const newFlat = newTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, newTree);
  const paths = new Set<string>([...oldFlat.keys(), ...newFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFlat.get(path);
    const newEntry = newFlat.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    const counts = lineDiffCounts(blobText(store, oldEntry?.oid ?? null), blobText(store, newEntry?.oid ?? null));
    changes.push({ path, status, oldOid: oldEntry?.oid ?? null, newOid: newEntry?.oid ?? null, additions: counts.additions, deletions: counts.deletions });
  }
  return changes;
}

export interface MergeOutcome {
  tree: string;
  conflicts: string[];
}

/** A per-path three-way merge of three trees; conflicting paths are listed, never guessed. */
export function mergeTrees(store: ObjectStore, baseTree: string | null, ourTree: string | null, theirTree: string | null): MergeOutcome {
  const base = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, baseTree);
  const ours = ourTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, ourTree);
  const theirs = theirTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameBlob = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (sameBlob(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (sameBlob(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (sameBlob(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { tree: treeFromFlat(store, merged), conflicts };
}

// ------------------------------------------------------------------ forge state

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  createdSec: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdSec: number;
  updatedSec: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  /** The head branch tip when the pull was created (a fallback once the branch is gone). */
  headSha: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSec: number | null;
  mergeCommitSha: string | null;
  authorLogin: string;
  createdSec: number;
  updatedSec: number;
  comments: Comment[];
}

export interface Repo {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  headRef: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSec: number;
}

export class Forge {
  store = new ObjectStore();
  identities = scenarioIdentities();
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;

  get viewer(): ScenarioUser {
    return this.identities.viewer;
  }

  /** Repositories are keyed by lowercase name; every repository belongs to the viewer. */
  repoKey(name: string): string {
    return name.toLowerCase();
  }

  findRepo(name: string): Repo | undefined {
    return this.repos.get(this.repoKey(name));
  }

  createRepo(name: string, priv: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      private: priv,
      description,
      defaultBranch: 'main',
      headRef: 'refs/heads/main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSec: nextTimestamp(),
    };
    this.repos.set(this.repoKey(name), repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(this.repoKey(name));
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** The commit oid a branch name or full ref points at, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Make a commit in this forge (contents API, merges) with the viewer's identity. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const sec = nextTimestamp();
    const data = buildCommitData({
      tree,
      parents,
      message,
      name: this.viewer.name,
      email: this.viewer.email,
      sec,
    });
    return this.store.put('commit', data);
  }
}
