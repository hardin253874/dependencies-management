# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project-specific instructions for the Dependencies Management Agent. Read this in full before touching code.

**The functional spec is the single source of truth.** It lives OUTSIDE this repo, in the Obsidian vault: `../working/dependencies-management/Plans/FUNCTIONAL_SPEC.md` (alongside `IMPLEMENTATION_PLAN.md`, stage reviews and `V1_CLOSURE_REPORT.md`). Every `Plans/…` reference below means that folder.

**v2 is in planning/progress (2026-11).** Before any v2 work read `Plans/V2_UPGRADE_PLAN.md` (goals, confirmed decisions D1–D11 + D14 ESLint 9 + D16 Node 24.22.2 (npm-registry-fetch 20 / arborist 10), stage status), then the stage doc you're working on: `V2_EVAL_HARNESS.md` (Stage 0), `V2_STACK_UPGRADE.md` (Stages 1–2), `V2_CODE_GRAPH_DESIGN.md` (Stage 3), `V2_AI_OVER_GRAPH.md` (Stage 4). For v2 work the V2 docs override the v1 spec where they disagree; update the spec when a v2 stage lands. Headline v2 changes: `src/core/` split (no Next/React imports; started in Stage 3 with `src/core/graph`, the rest still lives in `src/lib/`), per-project SQLite code graph (see "Code graph" below), Claude Agent SDK read-only investigator with MCP-first tools, OpenAI removed. Project subagents (`pm`, `developer`, `qa`) live in `.claude/agents/`. This file captures patterns and gotchas; the spec captures the design contract. When the two disagree, the spec wins — update this file to match.

---

## Project context in one paragraph

A locally-run AI-augmented agent that scans, analyses, and reviews dependencies of legacy JS/TS projects. Next.js 16.4 App Router + React 19.3 (Route Handlers, not Server Actions; Turbopack for dev and build since v2 Stage 2). Server binds 127.0.0.1 only. Six right-panel views per dep ([A]–[E] + [D-Deep]). Cache-first design: every view reads its persisted envelope first; LLM calls happen only on explicit user action. The agent is **read-only against target projects** — all writes go to `library/`.

Test baseline (2026-11-10, after v2 Stage 5b): 1351 passed / 5 skipped across 172 files (~10 s wall; the 4 extra skips are the `GRAPH_PERF=1`-gated perf budgets). Typecheck + lint must be clean before any commit.

## Commands

```bash
npm run dev                 # next dev (Turbopack) on 127.0.0.1:3000; `next dev --webpack …` to compare bundlers
npm run setup               # interactive: writes .env + library/_config.json
npm run typecheck && npm run lint && npm test   # lint = `eslint .` (ESLint 9 flat config, eslint.config.mjs; `next lint` was removed in Next 16 and `next build` no longer lints)
npm run eval -- help        # Stage 0 eval harness (vite-node eval/cli.ts; corpus in eval/corpus, output in eval/results)
npm run -s mcp              # read-only MCP server on stdio (vite-node src/mcp/server.ts); clients use the direct node command in README
npm run build && npm start  # production build (Turbopack), also bound to 127.0.0.1:3000
npx vitest run tests/backend/resolver.test.ts          # single file
npx vitest run tests/backend/resolver.test.ts -t "name" # single test
npm run test:e2e            # Playwright; auto-starts `npm run dev` (reuses a running one)
```

Vitest 5 `test.projects` (vitest.config.ts): `backend` = `tests/backend/**` → node, `frontend` = `tests/frontend/**` (incl. non-JSX `.test.ts`) → jsdom. A test file outside those two folders runs in neither project (`tests/backend/vitest-projects.test.ts` fails if one appears). `MOCK_LLM=true` answers LLM calls from `test-fixtures/llm/` (keyed by SHA of system+user prompt+tool+model); a missing fixture throws with the expected filename.

## Big-picture flow

1. **Add project** → Phase 1 (sync, `scanners/packageJson.ts` + `lockfile.ts`) writes `library/<slug>/project.json`.
2. **Phase 2** (`scanners/phase2.ts`, background job) fetches registry packuments + OSV CVEs + endoflife.date and writes per-dep envelopes; the StatusBar shows progress via SSE.
3. **Right-panel views** read cached envelopes via GET routes. User clicks POST a refresh → route enqueues a job on `lib/jobs/queue.ts` → a service runs → envelope written → FE `awaitJob` polls, then reloads.
4. **[C] Usage** is answered from the code graph: refresh routes call `refreshProjectGraph` (build or incremental rescan of `library/<slug>/graph.db`) and map it to the unchanged `UsageDetail` with `usageFromGraph` (`src/lib/graph/`). v1 `scanners/code.ts` `scanCode` stays only so the eval's v1 baseline keeps measuring v1.
5. **AI views** live in `lib/llm/*Service.ts` (report, relatedUpgrade, fileReview, deepReport, cveImpact). Since v2 Stage 4a, [D] and [D-Deep] default to the **agent engine** (`agentReportService.ts` / `agentDeepReportService.ts`, see "Agent loop" below); `_config.json` `llm.reportEngine: 'v1'` keeps the v1 single-shot services reachable. Each builds a deterministic skeleton from scanners (`code.ts` import graph, `resolver.ts` npm dry-run, `deepScan.ts`, `importSiteContext.ts`) and merges the LLM tool-call output on top. `llm/factory.ts` picks Anthropic / mock (OpenAI removed in v2; the factory is the seam for Microsoft Foundry). Each service passes an explicit `effort` from `llm/effort.ts`; the adapter (`llm/anthropic.ts`, SDK 1.x) uses `tool_choice: auto` + `strict` tools, prompt caching on tools + system, and maps `stop_reason: refusal` → `LLM_REFUSAL`.
6. `lib/api-types.ts` is the FE↔BE contract; `lib/client/api-client.ts` is the only FE caller; `lib/reports/render.ts` produces MD/HTML downloads.

---

## Code graph (v2 Stage 3) — `src/core/graph` + `src/lib/graph`

Design contract: `Plans/V2_CODE_GRAPH_DESIGN.md` + `Plans/V2_STAGE3_SPEC.md`; module map in `src/core/graph/README.md`. The rules that bite:

- **Core boundary (D1/D23).** `src/core/**` imports no `next`, `react`, `react-dom`, nothing from `src/app` / `src/components` / `src/lib/client` / `src/lib/http`, and uses **relative imports only** (no `@/`), because `npm run eval` runs under vite-node without the alias. ESLint (`no-restricted-imports` block in `eslint.config.mjs`) and `tests/backend/core-boundary.test.ts` enforce it. App code imports core via `@/core/...` as usual.
- **Location.** One DB per project at `library/<slug>/graph.db` (`graphDbPath(slug)` in `lib/paths.ts`). Derived data: on schema change or corruption it is dropped and rebuilt, never migrated. The core refuses a DB path inside the target project.
- **Read-only target.** The build only reads (readdir/stat/readFile), never opens `.env*`, never executes target configs (they are parsed as data). `tests/backend/graph/invariant.readonly.test.ts` is the guard.
- **Driver.** `node:sqlite` (builtin, no ExperimentalWarning on Node 24.22; Node 22 prints one). Only `core/graph/store.ts` imports it; WAL, one writer. `better-sqlite3` is the documented fallback behind `GraphDriver`, not installed.
- **`serverExternalPackages`** (`next.config.mjs`): `oxc-resolver` is a napi addon and Turbopack `next build` fails without the entry ("node addon is not placeable in ESM chunks"); `@babel/traverse` is externalized like `@babel/parser`. `node:sqlite` needs no entry.
- **App entry points** (`src/lib/graph/`): `refreshProjectGraph({ slug, projectRoot, report, signal })` builds with `mode: 'auto'` under `withProjectLock('graph:<slug>')` — a separate key from the slug's `project.json` lock, so a long build does not block those writers while two builds of one project serialize. `getGraphReader(slug)` hands out the cached read handle; use it synchronously, never across an `await`. Core `openGraphReader` itself throws `GraphNotBuiltError` when there is no DB or no completed build (`meta.builtAt` is the completion marker, written only in a build's commit).
- **Close readers before deleting.** On Windows an open SQLite handle makes `fs.rm(library/<slug>)` fail with EBUSY/EPERM. Anything that removes or replaces the project dir must run inside `withProjectGraphLock(slug, …)` and call `closeGraphReaders(slug)` first (see the project DELETE route).
- **Rebuild triggers.** `mode: 'auto'` does a full build when `meta.builder` (`GRAPH_BUILDER_ID` in `core/graph/build.ts`: builder version + pinned `@babel/parser`/`@babel/traverse`/`oxc-resolver`) changes. **Bump `GRAPH_BUILDER_VERSION` whenever parse/resolve/reach output changes for the same input**; a test ties the pins to `package.json`. Schema changes bump `SCHEMA_VERSION` (drop + recreate). Unreadable dirs/configs land in `BuildGraphResult.diagnostics` and `meta.diagnostics` (logged at warn by `refreshProjectGraph`).
- **Perf budgets** are gated: `$env:GRAPH_PERF='1'; npx vitest run tests/backend/graph/perf.test.ts`.

---

## Agent loop (v2 Stage 4a) — `src/core/agent` + `src/lib/agent` + `src/lib/llm/agent*.ts`

Design contract: `Plans/V2_STAGE4_SPEC.md` §2–§3 + `Plans/V2_AI_OVER_GRAPH.md`; module map, tool table and budget semantics in `src/core/agent/README.md`. The rules that bite:

- **Own loop, not the Agent SDK** (proposed D24 = D8's fallback): `runAgent` in `core/agent/loop.ts` on `@anthropic-ai/sdk` 1.x via the `AgentModel` seam (`lib/llm/agentAnthropic.ts`: `messages.stream` → `finalMessage`, `tool_choice: auto`, only the terminal `submit_*` tool `strict` (the API allows at most 24 optional params summed over all strict schemas of one request; the read tools have 29 and are validated by the registry; `registry.test.ts` guards the limits), explicit effort, no `thinking` param, cache breakpoints on last tool + system + rolling last user block, history never mutated so thinking blocks pass back byte-identical).
- **Tools are MCP-first and read-only.** One list: `createReadToolRegistry()` (`core/agent/tools`). The registry throws on any `capability !== 'read'`. Tools take `workspaceRoot` from `ToolContext`, read through `pathGuard` (graph file set + `package.json`, `.env*` refused before any fs call, realpath containment). Add a tool → add it to `CALLS` in `tests/backend/agent/invariant.readonly-tools.test.ts` (the test fails otherwise).
- **Budgets are hard and checked BEFORE each request** (projection in `loop.ts`; a normal turn needs room for a same-size final turn). Never add a code path that sends a request without going through `runAgent`'s projection.
- **Real API = spend gate (4c)**: `src/core/spend` (`ledger.ts`: `CAP_USD = 10` code constant, ledger + lock outside the repo under `%LOCALAPPDATA%\dep-agent-eval\_spend`; `gate.ts`: reserve worst case before, settle from API usage after, unpriced model refused). Eval `--real` (`eval/lib/real.ts`, the only eval file allowed a real client) refuses private cases and `--local`, reads only `ANTHROPIC_API_KEY` from `.env` in code, `maxRetries: 0`. `--stop-at-usd` can only lower the cap.
- **Run records**: `library/<slug>/runs/<runId>.json` (`lib/agent/runStore.ts`, envelope, `trigger` only `'user'`), written by the refresh routes next to the report envelope (`resultRef`). The report carries `agentRun` (runId, status, cost, trace calls) for the trace viewer. `library/<slug>/memory/` is reserved (L4), never created.
- **Agent graph handle**: the job opens its own `openGraphReader` for the run and closes it in `finally` (`lib/agent/reportJobs.ts`); the shared reader cache must not be held across awaits.
- **Scripted mock**: `MOCK_LLM=true` → `ScriptedAgentModel` from `test-fixtures/agent/<scenario>.json` (`MOCK_AGENT_SCENARIO` or the view id), keyed by scenario, not prompt hash. Tests pin models/intel with `setAgentModelOverride` / `setAgentIntelOverride` (globalThis, reset to `null` in `afterEach`); never let a test reach the npm registry.
- **Eval-importable**: files the eval imports (`agentReportService`, `agentRun`, `runStore`, `storage/config`, the prompts) use relative imports — vite-node has no `@/` alias.
- **Impacted files = graph base set + agent overlay (5a)**: the [D] detail's `impactedFiles` start from `core/agent/impactBase.ts` `impactBaseSet` (the v2-graph rule; also on the `deterministic-partial` envelope); the agent ranks/adds via `filesToModify` and excludes via the required `excludeFiles` terminal field, valid only for base files it `read_file`d in the run (`readPaths` on the run result/record). The agent terminal schema is `AGENT_UPDATE_REPORT_TOOL_SCHEMA` (v1 schema spread + `excludeFiles`); never edit v1 `UPDATE_REPORT_TOOL_SCHEMA` for agent needs. Scripted `submit_update_report` inputs must include `excludeFiles` (may be `[]`). Eval `v2-agent` scores the full set, `v2-agent:subset` the agent's pick. Details: `src/core/agent/README.md`.
- **Confirm before every run**: `AgentRunConfirmModal` (GET `…/reports|deep-reports/…/cost-estimate`: expected + `maxUsd`) gates every [D] / [D-Deep] Generate/Regenerate.

## Jev judge + model router (v2 Stage 5b) — `src/core/judge`, `src/core/llm/router.ts`, `src/lib/judge`

Design contract: `Plans/V2_STAGE5_SPEC.md` §4 (5b) + the J1–J8 table and D28 in `Plans/V2_UPGRADE_PLAN.md`; module map in `src/core/judge/README.md`; user docs in `README.md` ("Jev (TypeSafe) — optional"). The rules that bite:

- **One path to TypeSafe:** `Judge.ask` / `tryAsk` (`core/judge/judge.ts`) = privacy guard → cache → client. The J helpers (`core/judge/uses.ts`) and the router go through it; nothing else constructs `TypeSafeClient`. `tryAsk` never throws: a refusal / outage returns `{ ok: false }` and the caller keeps today's behaviour (a Jev failure never blocks a view, never an error toast). Per-item loops (J1–J4, J7 across advisories) share the context's `JudgeBreaker`: first outage → no more requests for that use in the job; all requests of one use together stay within `JEV_USE_DEADLINE_MS` (10 s). Never add a J loop that bypasses `askOnce`.
- **Payloads are built by class** (`core/judge/payload.ts`): `metadataPayload` accepts only numbers, booleans, fixed enums, npm names, semver, ISO dates (anything else throws `JudgePrivacyError`); `publicTextPayload` / `sourcePayload` cap sizes (snippet 40 lines / 2 KB, request ≤ 48k bound). `USE_CLASS` is the plan's "data sent" column; J2 on the [D] report reads evidence only for `filesToModify` paths in the graph file set / usage set (`reportEvidenceAllowedFiles`) that pass `pathGuard` (v1 paths are raw LLM output). `assertAllowed` refuses a wider class, a switch that is off, `judge: 'off'` projects, private eval cases, and **every use for a private or not-set (`privacy` missing = private, D30) project** except J1–J3 with the explicit `judgeSourceOptIn` (stricter than spec 5b.9; see the 5b dev notes).
- **Client options are all explicit** (D31): key, base URL, `defaultModel: 'jev-1.14.0'`, `logLevel: 'error'` + a body-free logger, `retry.maxRetries: 0`, `timeout`, `compression: false`. The SDK only reads `TYPESAFE_*` env vars for omitted options (checked in the installed `dist`). Router calls time out at 3 s.
- **Jev ledger, HARD $0.50** (`core/judge/ledger.ts`, `JEV_CAP_USD` code constant): reserve (UTF-8 bytes of the request × price × 1.1) before every real request, settle from `usage.input_tokens`; app `library/_spend/jev-round1.json` (opened per operation), eval `%LOCALAPPDATA%\dep-agent-eval\_spend\jev-round1.json` (held for the session). `src/core/spend/**` is frozen for Stage 5: never edit it for Jev.
- **Cache** `library/_judge/<sha256>.json` (key = use + model + state + questions + `JUDGE_PROMPT_VERSION`; bump it when a question text or builder output changes). Errors are never cached; same-key calls share one request (in-flight map on the cache instance).
- **Switches:** `_config.json` `judge: { enabled, router, flags: { J1…J8 } }`, all default false (`migrateConfig` fills them silently). `judgeContextFor(slug, config, use)` returns `null` when a switch is off: the call site then runs today's code path exactly (tests assert byte-identical output). Only user-triggered jobs take a judge context; a GET never does (`judgeContextCount` spy test).
- **Router** (`core/llm/router.ts`, D28 proposed): `routeRules` (pure) → Jev for unclear → configured model on anything else. `resolveModel` (`llm/factory.ts`) with `judge.router: false` returns the configured model and the job adds no `routing` field (requests unchanged). Cost-estimate GETs route with rules only (`estimateRouting`, `allowJudge: false`). Budgets derive from the routed model.
- **Project settings** live on `project.json` (`privacy`, `judge`, `judgeSourceOptIn`), written by `PATCH /api/projects/:slug` through the canonical writer (it holds project.json in memory); rescan / relocate carry them over (`judgeSettingsOf`).
- **Tests:** `MockJudgeClient` (`core/judge/mock.ts`, fixtures `test-fixtures/judge/<use>.json`, `MOCK_LLM=true` uses it too); pin one with `setJudgeClientOverride` and reset it to `null` in `afterEach`. No test may reach TypeSafe.
- **Eval:** `real.ts` stays the only eval file with a real client (`loadTypesafeKey` takes only `TYPESAFE_API_KEY`, `createRealJudgeClient`); other eval files may import `core/judge/client` as `import type` only (guard in `predict-v1.test.ts`). `eval router-arms` is offline (never calls Claude); `eval judge` is mock by default and refuses private cases. `eval judge --use router --opus/--sonnet/--haiku …` is the producer of the router Jev answers: it asks only the rule-unclear phases (≤ 5) through `routeModel` + `JudgeCache`, real answers under `<evalCache>/_judge`, mock under `<evalCache>/_judge-mock`; pass that dir to `router-arms --jev-cache`.

## MCP server (v2 Stage 4b) — `src/mcp`

Design contract: `Plans/V2_STAGE4_SPEC.md` §4 + `Plans/V2_AI_OVER_GRAPH.md` §5; user setup in `README.md` ("MCP server"). The rules that bite:

- **Thin adapter, no features.** `src/mcp/tools.ts` maps `createReadToolRegistry()` 1:1 (name, description, JSON Schema + a required `project` slug) plus `list_projects`. No `submit_*`, no graph build, no write/execute tool (the adapter re-checks `capability === 'read'`). A new registry tool shows up over MCP automatically; add it to `CALLS` in `tests/backend/mcp/protocol.test.ts` too.
- **SDK:** `@modelcontextprotocol/server` 2.4.0 (`McpServer.registerTool` + `StdioServerTransport`), `@modelcontextprotocol/client` 2.4.0 dev-only for tests. The low-level `Server` class is `@deprecated` in 2.4. Our JSON Schema is wrapped as a Standard Schema that calls core `validateInput`, so MCP and the agent loop accept the same inputs (not the SDK's AJV `fromJsonSchema`). Invalid input → `isError` result; unknown tool → JSON-RPC `-32602`.
- **stdout is protocol only.** `server.ts` routes `console.log/info/debug` to stderr before anything logs (the app logger prints to `console.log` outside production). Never `process.stdout.write` in code the server reaches. `npm run mcp` without `-s` is NOT a valid client command: npm's banner goes to stdout.
- **Relative imports only** in `src/mcp` (vite-node has no `@/` alias); ESLint block + `adapter.test.ts` enforce it, like `src/core`.
- **Library + graph:** library = `DEP_AGENT_LIBRARY_DIR` (absolute) or `<repo>/library` derived from the file location (clients start the server from their own cwd). Slugs resolve only via `_projects.json`, `workspaceRoot` = `project.json` `path`, and each call opens its own core `openGraphReader` and closes it (no web-app reader cache). Missing graph → `isError` "Graph not built …".

---

## Architectural invariants — non-negotiable

These are the rules; violating them is a bug, regardless of how convenient the shortcut looks.

### 1. Target project is read-only
The agent NEVER writes to, deletes from, or modifies the target project's source tree. The code graph build has a dedicated guard (`tests/backend/graph/invariant.readonly.test.ts`); the related invariant tests are `tests/backend/invariant.*.test.ts` (api-key, bind, csrf, singletons, traversal). If you touch code that does anything filesystem-y near `project.path`, your PR is suspect.

### 2. Cache-first, lazy AI
Every view reads its cached envelope first. LLM calls fire only on explicit user clicks ("Generate", "Regenerate", "Analyze"). Never silently auto-trigger an LLM call from a GET handler or a `useEffect` mount.

### 3. Local-only
- Server binds `127.0.0.1` only (`-H 127.0.0.1` in `package.json` scripts).
- CSRF (`X-Local-Token` header) required on all mutating requests.
- API key values never appear in any GET response.

### 4. Cross-route singletons live on `globalThis`
**Module-scoped mutable singletons are forbidden.** This is the most-frequently-violated rule in this codebase's history and is the root of about a third of the real bugs we've fixed.

```ts
// ❌ BUG — webpack dev evaluates this module per-route bundle, creating N independent instances
const STATES = new Map<string, WriterState>();
let logger: Logger | null = null;
let cachedToken: string | null = null;
```

```ts
// ✅ Correct — single instance per Node process
declare global {
  var __DEP_AGENT_MYTHING__: MyThing | undefined;
}
function getMyThing(): MyThing {
  if (globalThis.__DEP_AGENT_MYTHING__ === undefined) {
    globalThis.__DEP_AGENT_MYTHING__ = new MyThing();
  }
  return globalThis.__DEP_AGENT_MYTHING__;
}
```

If you `grep "^const [A-Z_]*\s*=\s*new (Map|Set)\(" src/lib/` and find a non-readonly hit in `src/lib/`, that's a flag. Same for `^let \w+` at module top level (read-only `let env = …` after first call is OK; mutable singletons are not).

Currently-pinned singletons: `JobQueue`, CSRF token, logger state, project locks, orphan cache, graph readers (`__DEP_AGENT_GRAPH_READERS__`, `lib/graph/readerCache.ts`), LLM client cache + its config signature (`__DEP_AGENT_LLM_SIGNATURE__`, `llm/factory.ts`), LLM concurrency limiters (`__DEP_AGENT_LLM_LIMITS__`), canonical-writer STATES, the test-only agent overrides (`__DEP_AGENT_AGENT_MODEL_OVERRIDE__` in `lib/agent/factory.ts`, `__DEP_AGENT_AGENT_INTEL_OVERRIDE__` in `lib/agent/intel.ts`), and the Jev wiring in `lib/judge/factory.ts` (`__DEP_AGENT_JUDGE_CACHES__` and `__DEP_AGENT_JEV_GATES__` keyed by path, the test-only `__DEP_AGENT_JUDGE_CLIENT_OVERRIDE__`, and the `__DEP_AGENT_JUDGE_ASKS__` spy counter).

Guards: `tests/backend/invariant.singletons.test.ts` (in `npm test`) fails on any top-level `let`/`var` or `const X = new Map|Set|…` in `src/lib/**` (minus `src/lib/client/`) and `src/core/**` (no allowlist entries allowed there) that is not in its allowlist with a reason. `tests/e2e/invariant.cross-route-singleton.spec.ts` checks at runtime that the CSRF token from `/api/csrf` is accepted by `PATCH /api/config`. Measured on Next 16.4: only webpack dev splits modules per route; Turbopack dev and production builds share one instance. So the rule still holds (`--webpack` is one flag away), but the e2e spec can only catch a regression under `next dev --webpack`. The static guard catches it with any bundler.

### 5. Test isolation
Every test that touches the library or a fixture project gets its own tempdir via `createSandbox(name)` (`tests/backend/helpers/sandbox.ts`). NEVER write to the developer's real `library/` from a test.

---

## Code patterns to follow

### Route handlers

Every route file in `src/app/api/**/route.ts` MUST be wrapped:

```ts
// GETs (read-only). Dynamic segments: `params` is a Promise (Next 15+), read it once at the top.
export const GET = withRequestLog<RouteCtx<{ slug: string }>>(async (_req, ctx) => {
  const params = await ctx.params;
  // ...
});

// Mutating routes (POST/PATCH/PUT/DELETE)
export const POST = withCsrf<RouteCtx<{ slug: string }>>(async (_req, ctx) => {
  const params = await ctx.params;
  // ...
});

// Routes without dynamic segments
export const GET = withRequestLog<unknown>(async () => { /* ... */ });
```

`RouteCtx<P>` lives in `src/lib/http/guards.ts` (named so it does not clash with Next's generated global `RouteContext`). In tests, call handlers with `routeCtx({ slug })` from `tests/backend/helpers/fixtures.ts`.

`withCsrf` composes `withRequestLog` internally — never wrap twice. The only intentional exception is the SSE stream `GET /api/jobs/[jobId]/events`, which streams indefinitely and would never produce a final status line.

### Cache-first GET pattern

```ts
const fp = depFilePath(slug, name);
if (!(await pathExists(fp))) {
  return notFound('NOT_CACHED', 'Generate the analysis first');
}
const env = await readEnvelope<DepDetail>(fp);
return NextResponse.json(env);
```

Use the `envelopeOr404` helper for the canonical "read cached file or 404" path.

### Atomic writes

ALL JSON writes go through `atomicWriteJson(filePath, value)` from `src/lib/storage/atomic.ts`. Temp-file → fsync → rename, with Windows EPERM retry. Never `fs.writeFile` directly to a path users might read concurrently.

### File envelope shape

Every cached JSON file (except `_config.json`, `_projects.json`) wraps its payload in:

```ts
interface Envelope<T> {
  schemaVersion: number;
  generatedAt: string;   // ISO
  source: 'registry' | 'deterministic' | 'deterministic-partial' | 'endoflife.date' | 'anthropic:<model>' | 'openai:<model>' /* read-only legacy (v1); writes use WritableEnvelopeSource */;
  ttlHours: number | null;
  data: T;
}
```

Use `writeEnvelope(filePath, { source, ttlHours, data })` to write; `readEnvelope<T>(filePath)` to read (applies schema migrations).

### Volta toolchain entries — TWO helpers, don't conflate

Volta pins (`node`, `npm`, `yarn`) live on `project.volta`, NOT in `project.dependencies`. Use the right helper:

- **Backend**: `findProjectDep(project, name)` in `src/lib/projects/lookup.ts` — synthesises a `ProjectDependency` for Volta entries on demand.
- **Frontend**: `findInstalledVersion(activeProject, depName)` in `src/lib/client/findInstalledVersion.ts` — returns the installed version including Volta lookup.

If you write a `project.dependencies.find(d => d.name === X)` anywhere, ask whether `X` could be a Volta name — if yes, you have a bug.

### Frontend job-wait pattern

Right-panel views poll `GET /api/jobs/:jobId` every 2 s via `apiClient.awaitJob(jobId, { signal })`. NEVER use the SSE `/events` route as a done-signal carrier (it closes on terminal state and the close races with the `done` event). SSE is fine for live progress in the StatusBar; it's not fine for "is the work finished yet?".

```ts
const controller = new AbortController();
jobWaitAbortRef.current = controller;
try {
  const { jobId } = await getApiClient().refreshUsageDetail(slug, name);
  await getApiClient().awaitJob(jobId, { signal: controller.signal });
  if (controller.signal.aborted) return;
  fetch.reload();
} catch (err) {
  if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
  pushToast({ severity: 'error', ... });  // SURFACE non-abort errors
} finally {
  if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
}
```

### Network calls — always set a timeout

Node 18+'s native `fetch` has NO default timeout. A stalled connection blocks `Promise.all` forever. Every outbound HTTP call to a real network endpoint MUST have an `AbortSignal.timeout`-style guard. See `src/lib/scanners/cve.ts`'s `withTimeout` helper for the canonical pattern. `npm-registry-fetch` takes a `timeout` option directly — pass it.

### Defensive renderer normalization

Caches written by older builds may be missing fields added in later versions. Frontend renderers MUST handle that gracefully:

```tsx
// ❌ Crashes when the cache predates the relatedDeps feature
{detail.relatedDeps.map(...)}

// ✅
const relatedDeps = detail.relatedDeps ?? [];
{relatedDeps.map(...)}
```

The real fix is to re-run the relevant Phase 2 / refresh — but the renderer must never throw on a legitimate-shape-from-an-older-build cache.

### Logger

`src/lib/logger.ts` exports `getLogger()` (async) and `getLoggerSync()` (returns null before first init, useful in hot paths). Use structured first-arg + message:

```ts
const log = (await getLogger()).child({ scope: 'phase2', slug });
log.info({ total, durationMs }, `phase2 registry done — ${ok}/${total} ok`);
```

DON'T import `pino` or `pino-pretty`. The v0.5 logger is a custom direct-file appender; pino was removed from the code (spec §10.11) and both packages were dropped from `package.json` in v2 Stage 1.

---

## Common bug classes to watch for

These are the bugs that have actually shipped in this repo. Each one is here because someone hit it in production.

| Bug class | Symptom | Avoid by |
|---|---|---|
| Module-scoped singleton in Next.js dev | Different routes see different instances (e.g. job enqueued in A, GET returns 404 from queue B) | Always use `globalThis.__DEP_AGENT_<NAME>__` |
| Self-referential `.then` chain | Promise waits for itself → deadlock (Phase 2 hung after envelope writes) | Use a `while (dirty)` loop, not recursive `.then` callbacks that reference the same promise |
| Missing fetch timeout | Single stalled request blocks `Promise.all` indefinitely | `withTimeout` helper or `AbortSignal.timeout(ms)` |
| Volta-toolchain `dependencies.find()` | `node`/`npm`/`yarn` buttons disabled or 404'd | Use `findProjectDep` (BE) / `findInstalledVersion` (FE) |
| Silent error swallow in async handler | "Nothing happened" when the user clicks | `catch (err) { if (aborted) return; pushToast({ severity: 'error', ... }); }` |
| Route URL contract drift | 404s in production that tests don't catch (because fake fetcher intercepts) | When renaming a route folder, grep the client + tests for the path string |
| Unhandled cache-shape mismatch | `Cannot read properties of undefined` in renderer | Defensive `?? defaults` at the renderer boundary |
| Pre-existing AI cache returned without source check | "Looks AI-generated" but `source: 'deterministic-partial'` | Render the `⚠ LLM unavailable` banner whenever `source === 'deterministic-partial'` |

---

## When you change something

### Before opening a PR

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm run lint        # ESLint — must be clean
npm test            # Full Vitest suite — must match current baseline (1351 pass / 5 skipped)
```

### When you change a route

1. Confirm the route is wrapped (`withCsrf` for mutations, `withRequestLog` for GETs).
2. Add a matching method to `src/lib/client/api-client.ts` if FE will call it.
3. If the fake fetcher in `tests/frontend/helpers/renderWithProviders.tsx` needs to know about the new URL, add it — otherwise frontend tests that hit the route will see uncaught fetches.
4. Verify the URL path between client + server + tests by grepping the literal path string.

### When you change a cached schema (`DepDetail`, `UsageDetail`, etc.)

1. Bump the migration registry in `src/lib/storage/migrations.ts` if you need to rewrite old caches.
2. Add defensive `?? defaults` reads in every renderer that touches the new field.
3. Don't rely on every cache being current — assume someone is running with a stale cache from last week.

### When you introduce a new module with mutable state

Read §3.6 of the spec. If your state needs to be visible across route handlers, put it on `globalThis.__DEP_AGENT_<NAME>__`. If it's per-request, keep it in the function scope.

### When you add a new LLM prompt

Add a new file under `src/lib/llm/prompts/` modeled on `update-report.ts`:
- Mustache template (no logic in the template; pre-compute everything).
- `ToolSchema` with strict `required[]` + `enum`s.
- Render function returns `string`.
- Output interface defines the parsed tool-call shape.

Then in your service file (`src/lib/llm/<feature>Service.ts`):
- Build a deterministic skeleton first.
- Compute cache key via `computeCacheKey({ systemPrompt, userPrompt, tool, model })`.
- Call `client.call<OutputShape>({ ... })`.
- Catch `LLMError`, log at `warn`, fall back to the skeleton with `source: 'deterministic-partial'`.
- Merge LLM output onto the skeleton by name (defends against missing/extra entries in the model's output).

See `src/lib/llm/relatedUpgradeService.ts` for the reference implementation.

### When tests fail

If `tests/backend/storage.atomic.test.ts` fails under parallel pressure with EPERM on Windows — it's the known v1.x backlog flake. Re-run in isolation (`npx vitest run tests/backend/storage.atomic.test.ts`) to confirm before assuming you broke something.

---

## Code style

- **TypeScript strict** everywhere. No `any` without a comment justifying it.
- **Path aliases**: import via `@/lib/...` not relative paths.
- **Comments explain WHY**, not WHAT. If a comment restates the code, delete it. If a function exists to dodge a Next.js / Windows / bundler quirk, the comment MUST name the quirk so the next person knows not to "simplify" it away.
- **Pure functions where possible** — easier to test. `src/lib/scanners/cve.ts`'s `deriveSeverity` is a good template.
- **Function declarations for top-level helpers**, arrow functions for callbacks.
- **`never` for exhaustive-switch defaults** — let TS catch missing cases.
- **No console.log in committed code** — use the logger.

---

## What NOT to do

- **Never run `git commit`.** The user commits manually. (See `~/.claude/CLAUDE.md` top-level rule.)
- **Never `--no-verify`** or skip hooks.
- **Never bypass `withCsrf` / `withRequestLog`** to "simplify a route".
- **Never write directly to a target project's path.** All writes go to `library/`.
- **Never `fs.writeFile` to a path read concurrently** — use `atomicWriteJson`.
- **Never call `console.log` from server code** — use the logger (so it lands in `_logs/server.log`).
- **Never assume an outbound fetch will return** — set a timeout.
- **Never silently swallow an error in an async handler the user triggered** — toast it.
- **Never add `module-scoped mutable state`** in `src/lib/` — use `globalThis`.
- **Never duplicate the spec.** Add a one-liner here that points at the spec section instead. Two sources of truth = drift.

---

## Where to find things

| Question | File / location |
|---|---|
| What does the agent do? | `Plans/FUNCTIONAL_SPEC.md` §1–§2 |
| What's the API surface? | `Plans/FUNCTIONAL_SPEC.md` §9 |
| How does X view work? | `Plans/FUNCTIONAL_SPEC.md` §7.6 |
| LLM prompt for X? | `src/lib/llm/prompts/X.ts` + `Plans/FUNCTIONAL_SPEC.md` Appendix A |
| What's the latest change? | Changelog at top of `Plans/FUNCTIONAL_SPEC.md` |
| Why does this `next.config.mjs` setting exist? | `Plans/FUNCTIONAL_SPEC.md` §5.1.1 |
| Test sandbox pattern? | `tests/backend/helpers/sandbox.ts` |
| FE test render harness? | `tests/frontend/helpers/renderWithProviders.tsx` |
| Fake fetcher for FE tests? | Same file as above |

---

## When in doubt

1. Read the relevant section of `Plans/FUNCTIONAL_SPEC.md`.
2. Read the most-recent changelog entry — it explains the most recent bugs and how they were fixed.
3. Look at existing similar code (the spec lists three "fixture" projects but the codebase itself is the best fixture).
4. If still uncertain — and per the global CLAUDE.md "stop after 3 attempts and reassess" rule — surface the question explicitly rather than guessing.
