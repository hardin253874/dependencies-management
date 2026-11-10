# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Project-specific instructions for the Dependencies Management Agent. Read this in full before touching code.

**The functional spec is the single source of truth.** It lives OUTSIDE this repo, in the Obsidian vault: `../working/dependencies-management/Plans/FUNCTIONAL_SPEC.md` (alongside `IMPLEMENTATION_PLAN.md`, stage reviews and `V1_CLOSURE_REPORT.md`). Every `Plans/…` reference below means that folder.

**v2 is in planning/progress (2026-11).** Before any v2 work read `Plans/V2_UPGRADE_PLAN.md` (goals, confirmed decisions D1–D11 + D14 ESLint 9 + D16 Node 24.22.2 (npm-registry-fetch 20 / arborist 10), stage status), then the stage doc you're working on: `V2_EVAL_HARNESS.md` (Stage 0), `V2_STACK_UPGRADE.md` (Stages 1–2), `V2_CODE_GRAPH_DESIGN.md` (Stage 3), `V2_AI_OVER_GRAPH.md` (Stage 4). For v2 work the V2 docs override the v1 spec where they disagree; update the spec when a v2 stage lands. Headline v2 changes: `src/core/` split (no Next/React imports; not created yet — code still lives in `src/lib/`), per-project SQLite code graph, Claude Agent SDK read-only investigator with MCP-first tools, OpenAI removed. Project subagents (`pm`, `developer`, `qa`) live in `.claude/agents/`. This file captures patterns and gotchas; the spec captures the design contract. When the two disagree, the spec wins — update this file to match.

---

## Project context in one paragraph

A locally-run AI-augmented agent that scans, analyses, and reviews dependencies of legacy JS/TS projects. Next.js 16.4 App Router + React 19.3 (Route Handlers, not Server Actions; Turbopack for dev and build since v2 Stage 2). Server binds 127.0.0.1 only. Six right-panel views per dep ([A]–[E] + [D-Deep]). Cache-first design: every view reads its persisted envelope first; LLM calls happen only on explicit user action. The agent is **read-only against target projects** — all writes go to `library/`.

Test baseline (2026-11-10, after v2 Stage 2): 686 passed / 1 skipped across 117 files (~8 s wall). Typecheck + lint must be clean before any commit.

## Commands

```bash
npm run dev                 # next dev (Turbopack) on 127.0.0.1:3000; `next dev --webpack …` to compare bundlers
npm run setup               # interactive: writes .env + library/_config.json
npm run typecheck && npm run lint && npm test   # lint = `eslint .` (ESLint 9 flat config, eslint.config.mjs; `next lint` was removed in Next 16 and `next build` no longer lints)
npm run eval -- help        # Stage 0 eval harness (vite-node eval/cli.ts; corpus in eval/corpus, output in eval/results)
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
4. **AI views** live in `lib/llm/*Service.ts` (report, relatedUpgrade, fileReview, deepReport, cveImpact). Each builds a deterministic skeleton from scanners (`code.ts` import graph, `resolver.ts` npm dry-run, `deepScan.ts`, `importSiteContext.ts`) and merges the LLM tool-call output on top. `llm/factory.ts` picks Anthropic / mock (OpenAI removed in v2; the factory is the seam for Microsoft Foundry). Each service passes an explicit `effort` from `llm/effort.ts`; the adapter (`llm/anthropic.ts`, SDK 1.x) uses `tool_choice: auto` + `strict` tools, prompt caching on tools + system, and maps `stop_reason: refusal` → `LLM_REFUSAL`.
5. `lib/api-types.ts` is the FE↔BE contract; `lib/client/api-client.ts` is the only FE caller; `lib/reports/render.ts` produces MD/HTML downloads.

---

## Architectural invariants — non-negotiable

These are the rules; violating them is a bug, regardless of how convenient the shortcut looks.

### 1. Target project is read-only
The agent NEVER writes to, deletes from, or modifies the target project's source tree. There is no dedicated test for this yet (the related invariant tests are `tests/backend/invariant.*.test.ts`: api-key, bind, csrf, singletons, traversal). If you touch code that does anything filesystem-y near `project.path`, your PR is suspect.

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

Currently-pinned singletons: `JobQueue`, CSRF token, logger state, project locks, orphan cache, LLM client cache + its config signature (`__DEP_AGENT_LLM_SIGNATURE__`, `llm/factory.ts`), LLM concurrency limiters (`__DEP_AGENT_LLM_LIMITS__`), canonical-writer STATES.

Guards: `tests/backend/invariant.singletons.test.ts` (in `npm test`) fails on any top-level `let`/`var` or `const X = new Map|Set|…` in `src/lib/**` (minus `src/lib/client/`) that is not in its allowlist with a reason. `tests/e2e/invariant.cross-route-singleton.spec.ts` checks at runtime that the CSRF token from `/api/csrf` is accepted by `PATCH /api/config`. Measured on Next 16.4: only webpack dev splits modules per route; Turbopack dev and production builds share one instance. So the rule still holds (`--webpack` is one flag away), but the e2e spec can only catch a regression under `next dev --webpack`. The static guard catches it with any bundler.

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
npm test            # Full Vitest suite — must match current baseline (686 pass / 1 skipped)
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
