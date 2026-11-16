# Build transcript — GitHub-compatible git forge (make.fun bounty github-core-clone-01)

Session summary, 16 Nov 2026 (Asia/Jakarta). Builder: Muse subagent working
autonomously; the account holder submits the finished entry himself.

## 1. Recon and kit

- Read the verified brief: standalone GitHub-compatible forge, no UI; one
  process serving git smart HTTP + REST v3 + GraphQL + MCP from its own
  store; Node 22 or Python 3.13; stdlib + vendored source only; ≤16 MiB
  source; score = feature 600 + agent (MCP) 200 + performance 200; a prize
  requires beating the house reference forge's score.
- Downloaded the kit from https://make.fun/c/github-core-clone-01/kit and
  preserved it byte-identical at
  `~/workspace/makefun/work/kit/github-core-clone-01-kit/`.
- Read in full before coding: RULES.txt, the wire contract (`wire.ts`),
  `manifest.ts` (the 120 checks), the reference clients (`rest-client.ts`,
  `git-client.ts`, `graphql-client.ts`, `mcp-client.ts`), the check files,
  `bench.ts` (the four performance workloads), the env (`main.ts`,
  `calibration.json`), `competition.yaml`, and the starter (`main.ts`,
  `LICENSE`).
- Key facts extracted: the grading env boots the entry, expects registration
  within a ~20 s boot window, runs 120 conformance checks plus four bench
  workloads (200 pushes, 50 clones, 2000 reads, 200 writes), and scores
  performance against calibration references measured 2026-11-14
  (push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms).

## 2. Design decisions

- **Node + erasable-syntax TypeScript**, stdlib only — matches the starter's
  `node main.ts` launch and Node's type stripping; zero install/build risk.
- **Fully in-memory store** (nothing in the kit requires persistence; it is
  also the fastest option for the bench). One content-addressed object store
  shared by all repos and all four API surfaces.
- **Deterministic logical clock** for forge-minted timestamps.
- **Scenario identities derived at boot** by reimplementing the kit's seeded
  RNG (fnv1a64 / mix64 / xorshift64*) — the viewer resolves to `adaiversen`
  (id 1000), matching the graded scenario exactly.
- Bearer token enforced on REST/GraphQL/MCP; git endpoints left
  unauthenticated deliberately (never tested for refusal; enforcing risked
  breaking real-git flows).

## 3. Implementation order

1. `scenario.ts` + `store.ts` — identities, users/repos/issues/PRs, git
   object model (trees, commits, ancestry, diff, three-way merge).
2. `pack.ts` — pkt-lines, pack reader with full OFS/REF delta resolution
   (compressed-length found by binary search over inflate attempts),
   pack writer, sideband framing.
3. `gitproto.ts` — smart HTTP v0 + v2: advertisements, ls-refs, fetch
   planning (have/want negotiation, shallow/deepen), receive-pack with
   fast-forward enforcement.
4. `rest.ts` — REST v3 surface.
5. `graphql.ts` — hand-rolled GraphQL lexer/parser/executor with
   introspection and global node ids.
6. `mcp.ts` — JSON-RPC endpoint (discovery + legacy initialize), six tools.
7. `app.ts` + starter `main.ts` — HTTP shell, routing, auth, lifecycle.

## 4. Testing and fixes

- **Real git CLI battery** (git 2.43): clone, push, branch, annotated tag,
  shallow clone, deepen, pull, non-FF rejection, ref deletion, v0 clone —
  all passed after fixes below.
- **Kit suite run 1: 116/120.** Failures → root causes → fixes:
  - Sideband packet overflow: pack data per packet must be ≤ 65515 bytes
    (the 4-byte header counts toward 65520). Fixed in `sidebandWrap`.
  - GraphQL introspection 500s: `__type` delegation recursed when the type
    was already `Query`. Fixed.
  - A handler name in `rest.ts` collided with a store import. Renamed.
- **Protocol lessons from real git** (lenient test parsers accepted these;
  git did not):
  - v2 fetch: never emit an `acknowledgments` section after the client's
    `done`; emit `shallow-info` only when non-empty.
  - v0 want line: capabilities follow the oid after a space (0x20), not NUL —
    confirmed by hex capture; the v0 request ends with a `done` pkt-line and
    no trailing flush.
  - `deepen`: real git sends `deepen N` + `deepen-relative` (deepen *by* N
    below the shallow boundary); the suite client sends bare `deepen N`
    meaning total depth. Both semantics implemented in fetch planning.
- **Kit suite run 2: 120/120** (feature 600/600, MCP 15/15 → agent 200/200).
  Run 3 with `--perf`: 120/120, perf 120/200 on this shared 1.5-CPU VM.
- **Raw latency spot-checks:** REST issue GET ≈ 0.36 ms/op, POST ≈ 0.18 ms/op,
  info/refs ≈ 0.21 ms/op server-side — the bench is client/CPU-bound locally.

## 5. Full grading rehearsal

Ran the kit's real sealed environment (`program/env/server.mjs`) against the
entry with a fresh state dir, exactly as a graded trial runs:

- Boot: entry registered in 337 ms (window ≈ 20 s).
- Conformance: **120/120 passed, working 1**.
- Benchmark: push p50 843.987 ms → 37 pts; clone p50 143.388 ms → 36 pts;
  read p50 841.809 ms → 46 pts; write p50 93.832 ms → 49 pts;
  **performance 168/200**.
- Export: `state.json` and `perf.json` written by the env; entry logged
  `done` and exited cleanly.
- **Rehearsal total: 968/1000** (reference forge ≈ 885–922 at its own
  calibration).

A first rehearsal attempt also confirmed the env's boot deadline behavior:
an entry that registers after ~20 s is graded 0 — this entry boots in
about a second, so it is comfortably inside.

## 6. Final state

- Entry: `~/workspace/makefun/git-forge/` — 167 KB total source, largest
  file 46 KB, MIT license included, README included.
- `BUILD-REPORT.md` (same directory) contains coverage details, known gaps,
  and the exact submission steps for the account holder.
- Deadline for submission: Sat 21 Nov 2026, 13:30 WIB.
