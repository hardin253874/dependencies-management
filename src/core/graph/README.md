# src/core/graph — per-project code graph (v2 Stage 3a)

Builds and incrementally updates a SQLite graph of a target project's files,
packages, imports, re-exports and usages, and answers "who uses package X,
where, and through which path". Contract: `V2_STAGE3_SPEC.md` §2–§3 and
`V2_CODE_GRAPH_DESIGN.md` (planning vault, outside the repo).

## Rules

- **No Next/React imports, relative imports only** (D1/D23, enforced by
  ESLint; `npm run eval` runs under vite-node without the `@/` alias).
- **Read-only on the target**: only readdir/stat/realpath/readFile under the
  project root, `.env*` never opened, configs parsed as data and never
  executed, the DB must live outside the project (`GraphPathError`).
- **No module-scoped mutable state** (singleton guard covers `src/core`).
  Callers own and close DB handles.
- `graph.db` is derived data: schema change or corruption → drop and rebuild,
  never migrate (D2).

## Module map

| File | Role |
|---|---|
| `store.ts` | The only `node:sqlite` import. `GraphDriver`, `openGraphWriter` (path guard, WAL, rebuild rules), `openGraphReader`, typed errors |
| `schema.ts` | Tables + indexes, `SCHEMA_VERSION` |
| `rows.ts` | Typed insert/update/select helpers per handle |
| `walk.ts` | Source-file discovery (`.gitignore` + skip dirs, `.env*` hard skip, size/minified rules) |
| `configFiles.ts` | Known config file names (data vs JS configs) |
| `parse.ts` | `ParserAdapter` + Babel implementation (imports, exports, re-exports, scope-based usages), `fileRole` |
| `style.ts` | `@import/@use/@forward/url()` extraction for `.css/.scss/.sass/.less` |
| `configRefs.ts` | Package references in babel/eslint/postcss/jest/tsconfig/package.json configs |
| `aliases.ts` | Static webpack/vite/next/craco alias reader |
| `jsonc.ts` | Comment/trailing-comma tolerant JSON |
| `resolve.ts` | `oxc-resolver` setup from the target's tsconfig/package.json/workspaces/aliases; style resolution |
| `reach.ts` | Symbol links, orphan pruning, `binding_reach` + `package_reach` (recursive CTE) |
| `build.ts` | `buildGraph` full / incremental, one write transaction, injected lock, abort, progress |
| `query.ts` | Public read API: `filesUsingPackage`, `symbolsUsed`, `usageSites`, `dependents`, `affectedEntryPoints`, `testsCovering`, `wrappers`, `unresolved`, `graphInfo` |
| `dump.ts` | Id-independent table dump (tests, debugging) |
| `types.ts` | Public types |

## Externals

`oxc-resolver` (napi addon) and `@babel/traverse` are in
`serverExternalPackages` (next.config.mjs). `node:sqlite` needs no entry.

## Tests

`tests/backend/graph/**` (fixtures in `test-fixtures/graph/**`, copied into a
sandbox by `tests/backend/helpers/graphFixture.ts`). Perf budgets:
`$env:GRAPH_PERF='1'; npx vitest run tests/backend/graph/perf.test.ts`.
