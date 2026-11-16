// Packfiles and pkt-lines, in pure stdlib (node:zlib, node:crypto): the rules forbid a git
// binary, so the wire formats live here. Reading accepts plain objects and OFS_DELTA /
// REF_DELTA chains (resolved recursively); writing emits plain objects only, which every
// client accepts. zlib's inflateSync ignores trailing bytes and throws on a truncated
// stream, so the exact compressed length of one object is found by binary search.

import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, sha1Hex, type GitObjectType, type ObjectStore } from './store.ts';

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too large');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Parse as many whole pkt-lines as `buffer` holds; `consumed` counts the bytes they took. */
export function parsePkts(buffer: Buffer, offset = 0): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2 || length === 3) {
      packets.push({ kind: 'data', data: Buffer.alloc(0) });
      at += length;
      continue;
    }
    if (at + length > buffer.length) break;
    packets.push({ kind: 'data', data: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, consumed: at - offset };
}

/** Wrap a payload in side-band packets (band byte prefix), chunked under the pkt limit. */
export function sidebandWrap(payload: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line's length field counts its own 4 header bytes and may not exceed 65520, so a
  // side-band packet carries at most 65520 - 4 (header) - 1 (band byte) = 65515 data bytes.
  const MAX_DATA = 65_515;
  for (let at = 0; at < payload.length; at += MAX_DATA) {
    const chunk = payload.subarray(at, Math.min(payload.length, at + MAX_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ packs

const TYPE_IDS: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a version-2 pack holding exactly `oids` (plain objects, no deltas). */
export function writePack(store: ObjectStore, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    const typeNumber = TYPE_NUMBERS[object.type];
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (typeNumber << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** The exact compressed length of the zlib stream starting at `offset`. */
function compressedLength(buffer: Buffer, offset: number, expectedSize: number): number {
  let lo = 1;
  let hi = buffer.length - offset;
  const attempt = (length: number): boolean => {
    try {
      const out = inflateSync(buffer.subarray(offset, offset + length));
      return out.length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!attempt(hi)) throw new Error('corrupt pack: object does not inflate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (attempt(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/** Parse a pack into raw entries (deltas unresolved), verifying the trailer checksum. */
function parsePackEntries(pack: Buffer): { entries: Map<number, PackEntry>; order: number[] } {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = sha1Hex(pack.subarray(0, pack.length - 20));
  if (!Buffer.from(digest, 'hex').equals(trailer)) throw new Error('pack checksum mismatch');
  const entries = new Map<number, PackEntry>();
  const order: number[] = [];
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset to the base entry.
      let b = pack[at] as number;
      at += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (typeId === 7) {
      // REF_DELTA: the base object's id.
      baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const length = compressedLength(pack, at, size);
    const data = inflateSync(pack.subarray(at, at + length));
    at += length;
    if (typeId === 6 || typeId === 7) {
      // Delta entry: `type` is a placeholder; the resolved type is the base's.
      entries.set(entryOffset, { type: 'blob', data, baseOid, baseOffset });
      order.push(entryOffset);
    } else {
      const type = TYPE_IDS[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      entries.set(entryOffset, { type, data });
      order.push(entryOffset);
    }
  }
  return { entries, order };
}

function readVarint(buffer: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = buffer[at] as number;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while ((byte & 0x80) !== 0);
  return { value, next: at };
}

/** Apply a git delta to its base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const source = readVarint(delta, at);
  at = source.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readVarint(delta, at);
  at = target.next;
  const parts: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== target.value || written !== target.value) throw new Error('delta target size mismatch');
  return out;
}

export interface ParsedPack {
  /** oid -> object, deltas resolved. */
  objects: Map<string, { type: GitObjectType; data: Buffer }>;
  count: number;
}

/** Parse a pack fully into the store (and a returned map), resolving delta chains. */
export function ingestPack(store: ObjectStore, pack: Buffer): ParsedPack {
  const { entries, order } = parsePackEntries(pack);
  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolve = (offset: number, depth: number): { type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(offset);
    if (cached !== undefined) return cached;
    if (depth > 64) throw new Error('delta chain too deep');
    const entry = entries.get(offset);
    if (entry === undefined) throw new Error('delta base missing from pack');
    let result: { type: GitObjectType; data: Buffer };
    if (entry.baseOffset === undefined && entry.baseOid === undefined) {
      result = { type: entry.type, data: entry.data };
    } else {
      let base: { type: GitObjectType; data: Buffer };
      if (entry.baseOffset !== undefined) {
        base = resolve(entry.baseOffset, depth + 1);
      } else {
        const baseOid = entry.baseOid as string;
        const existing = store.get(baseOid);
        if (existing !== undefined) {
          base = existing;
        } else {
          // A REF_DELTA base inside the same pack: find its entry by hashing candidates.
          let found: { type: GitObjectType; data: Buffer } | undefined;
          for (const candidateOffset of order) {
            const candidate = resolve(candidateOffset, depth + 1);
            if (hashObject(candidate.type, candidate.data) === baseOid) {
              found = candidate;
              break;
            }
          }
          if (found === undefined) throw new Error('delta base not found');
          base = found;
        }
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved.set(offset, result);
    return result;
  };
  const objects = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const offset of order) {
    const object = resolve(offset, 0);
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    store.putKnown(oid, object.type, object.data);
  }
  return { objects, count: order.length };
}
