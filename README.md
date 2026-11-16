# git-forge

A standalone, GitHub-compatible git forge in a single Node process — no UI, no
dependencies, no git binary. It serves four surfaces from one in-memory store:

- **Git smart HTTP** — protocol v0 and v2 (`info/refs`, `git-upload-pack`,
  `git-receive-pack`): clone, fetch, push, branches, tags, shallow clones and
  deepen, non-fast-forward rejection. Packfiles are parsed and written natively
  (OFS/REF delta resolution included).
- **REST v3 API** — repositories, contents, commits, branches, issues, labels,
  pull requests (including squash merges), and the authenticated user,
  GitHub-shaped JSON throughout.
- **GraphQL** — repository / issue / pull-request queries and mutations, global
  node ids, connections, and schema introspection.
- **MCP** — JSON-RPC tools endpoint (discovery + legacy initialize) exposing
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, and `merge_pull_request`.

## Running

```
node main.ts
```

The process binds an ephemeral port, serves `GET /healthz`, and registers its
base URL with the make.fun environment (`MAKEFUN_ENV_URL`), exiting cleanly
when the environment signals done. API surfaces require
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Design notes

- **Node standard library only** (`node:http`, `node:zlib`, `node:crypto`);
  TypeScript in erasable syntax only, executed directly by Node's type
  stripping — nothing to install or build.
- **Fully in-memory, content-addressed object store** shared by all
  repositories: one object graph serves git, REST, GraphQL, and MCP, so every
  surface always agrees.
- **Deterministic**: forge-minted timestamps come from a logical clock;
  identical request sequences produce identical responses.
- Robust to malformed input: bad packs, bad JSON, and unknown routes produce
  errors, never crashes.

## Layout

| File          | Contents                                             |
|---------------|------------------------------------------------------|
| `main.ts`     | Process lifecycle: listen, register, wait for done   |
| `app.ts`      | HTTP server, routing, bearer auth                    |
| `store.ts`    | Forge state: users, repos, issues, PRs, git objects  |
| `pack.ts`     | Pkt-lines, packfile read/write, delta resolution     |
| `gitproto.ts` | Smart-HTTP protocol v0/v2: ls-refs, fetch, push      |
| `rest.ts`     | REST v3 endpoints                                    |
| `graphql.ts`  | GraphQL parser, schema, executor                     |
| `mcp.ts`      | MCP JSON-RPC endpoint and tools                      |
| `scenario.ts` | Deterministic scenario identity derivation           |

MIT licensed — see `LICENSE`.
