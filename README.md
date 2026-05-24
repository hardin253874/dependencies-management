# Dependencies Management Agent

A locally-run, AI-augmented dependencies analysis agent for legacy JavaScript/TypeScript projects.

Scan, analyse, and review the direct dependencies of a Next.js (or general JS/TS) project. The agent layers an LLM on top of deterministic data (npm registry, OSV.dev CVEs, endoflife.date, your code's import graph) to answer questions a static report can't:

- **Which files in my project actually import this dep?** → view [C] Usage
- **What other deps must move together if I upgrade X?** → view [D] Update Report (with view [B]'s "Analyze related deps" pre-flight)
- **Is this dep abandoned, EOL, or sitting on critical CVEs?** → view [A] Dependency Detail (with the "Related deps in this project" health grid)

Designed for senior developers driving long-term dependency hygiene on legacy frontend apps.

## Privacy posture

- **Local-only.** Server binds `127.0.0.1` only — never exposed on the network.
- **Read-only against the target project.** The agent never writes to or modifies the target project's source tree. All persistent state lives in this repo's `library/` directory.
- **No telemetry, no analytics, no phone-home.** Your code stays on your machine.
- **API keys** are stored in a local `.env` file with `chmod 600` on Unix (best-effort on Windows). They never appear in any GET response.


## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 LTS | Tested with Node 20 + 22. The setup script needs Node ≥ 18 for native `readline/promises`. |
| `npm` on `PATH` | Used by the agent's resolver-check feature (`npm install --dry-run`). Volta-pinned `npm` is preferred when the target project has it. |
| LLM API key | Anthropic or OpenAI (at least one). You can also run with `MOCK_LLM=true` for dev iteration without spend — see [Development](#development). |
| OS | Windows, macOS, Linux. Windows has a couple of extra `next.config.mjs` notes — see the spec §5.1.1; everything is wired up correctly out of the box. |

## Quick start

```bash
# 1. Clone the agent
git clone <agent-repo-url> dependencies-management
cd dependencies-management

# 2. Install dependencies
npm install

# 3. Run the interactive setup (writes .env + library/_config.json)
npm run setup

# 4. Start the dev server
npm run dev
```

When the dev server starts, open <http://127.0.0.1:3000>. The first run launches an onboarding flow that walks you through adding your first project.

### What `npm run setup` does

The setup script (`scripts/setup.mjs`) is interactive and idempotent — running it again lets you update or keep existing values.

1. Asks which LLM provider(s) to enable (`anthropic`, `openai`, or both).
2. Prompts for the corresponding API key(s).
3. Optionally walks through the 6 token-budget knobs (you can press Enter to accept defaults — covers 99% of users).
4. Writes:
   - `.env` (credentials + tunables; **gitignored**)
   - `library/_config.json` (UI / feature config; also gitignored as part of `library/`)

If you'd rather configure manually, copy `.env.example` to `.env`, fill in the keys, and the server will reconcile against `.env.example` on first boot and prompt for anything missing.

## Scripts

```bash
npm run dev         # Start the dev server on 127.0.0.1:3000 (HMR enabled)
npm run build       # Production build
npm start           # Run the production build on 127.0.0.1:3000
npm run setup       # Interactive setup (writes .env + library/_config.json)
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # Vitest (unit + integration)
npm run test:watch  # Vitest watch mode
npm run test:e2e    # Playwright (UI smoke tests)
```

## Adding a project

1. Click **+ Add project** in the left panel.
2. Browse the filesystem picker to the project root (the folder containing `package.json` + a supported lockfile). The picker starts at the filesystem roots — on Windows that's drive letters that actually exist; on Unix it's `/`.
3. The agent runs a Phase 1 sync scan (~1 s — parses `package.json` + lockfile) then kicks off a Phase 2 background scan that fetches every dep's npm registry packument + OSV CVE data. The middle panel populates immediately; badges fill in as Phase 2 progresses (status bar shows the percentage).
4. Click any dependency to open the right-panel detail view.

### Supported lockfiles

- `package-lock.json` (npm) — fully supported
- `yarn.lock` (Yarn Classic / Berry) — supported, but the resolver-check feature is npm-only in v1

If both lockfiles exist, npm wins silently.

### What gets cached

All scan + analysis output lands in `library/<project-slug>/`:

```
library/
├── _config.json                # global config
├── _projects.json              # registered project list
├── _logs/server.log            # JSON-line request + scanner log
├── _endoflife/                 # global endoflife.date cache (7-day TTL)
│
└── <project-slug>/
    ├── project.json            # metadata + dep list + Phase 2 badges
    ├── deps/<n>.json           # [A] per-dep data (24h TTL)
    ├── versions/<n>/<v>.json   # [B] per-version data (7d TTL)
    ├── usage/<n>.json          # [C] file-usage per dep
    ├── file-reviews/<n>/…      # [E] AI file review (per dep × file)
    ├── reports/<n>/…           # [D] Update Report (per from→to)
    ├── related-upgrade/<n>/…   # [B/D] Related-deps upgrade analysis
    └── deep-reports/<n>/…      # [D-Deep] L2+L3 deep report
```

Everything is JSON, atomic-written (temp-then-rename), wrapped in a versioned envelope. Cache-first by design: every view shows cached data instantly and only fires the (potentially expensive) refresh on explicit user action.

## Six right-panel views

| Code | Name | Opens via |
|---|---|---|
| [A] | Dependency Detail | Click a dep in the middle panel |
| [B] | Version-Mapping View | Click a version inside [A]'s Available versions |
| [C] | Usage View | "Usage" button in [A] |
| [D] | Update Report | "Analyze report" button in [B] |
| [D-Deep] | Deep Update Report | "Deep Analyze" button in [D] |
| [E] | File-Level AI Review | Click a file inside [C] |



## Configuration

### `.env` (credentials + tunables)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required when `_config.json.llm.provider === 'anthropic'` |
| `OPENAI_API_KEY` | — | Required when `_config.json.llm.provider === 'openai'` |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `MOCK_LLM` | `false` | When `true`, LLM calls are replied to from `test-fixtures/llm/` |
| `TOKEN_BUDGET_FILE_REVIEW_IN` | 30000 | See [`Plans/FUNCTIONAL_SPEC.md`](Plans/FUNCTIONAL_SPEC.md) §11.3 |
| `TOKEN_BUDGET_FILE_REVIEW_OUT` | 4000 | |
| `TOKEN_BUDGET_UPDATE_REPORT_IN` | 10000 | |
| `TOKEN_BUDGET_UPDATE_REPORT_OUT` | 6000 | |
| `TOKEN_BUDGET_DEEP_REPORT_IN` | 100000 | |
| `TOKEN_BUDGET_DEEP_REPORT_OUT` | 8000 | |

`.env` is read **once at startup** into a typed config module. The exceptions are API keys — when you change a key from the Settings panel, the server hot-patches the in-process config and re-instantiates the LLM client without a restart. Token-budget changes do require a restart; the Settings UI will tell you when one is needed.

### `library/_config.json` (app config — hot-reloadable)

```jsonc
{
  "schemaVersion": 1,
  "llm": { "provider": "anthropic", "model": "claude-opus-4-7" },
  "ui": {
    "sidebarCollapsed": false,
    "theme": "light",
    "showDeepAnalyzeWarning": true
  },
  "features": {
    "resolverCheckEnabled": true
  }
}
```

This file is re-read on every request that needs it — Settings → Behavior toggles take effect immediately, no restart required.

## Cost discipline

The agent will NEVER make an LLM call without an explicit user click. Every view is cache-first, so the only AI cost paid is on user-triggered "Generate" / "Regenerate" / "Analyze" actions. The first "Deep Analyze" per project shows a confirmation modal with the estimated token + USD cost; subsequent runs skip it unless you re-enable the prompt in Settings.

Per-call cost is tracked on each cached envelope's `cost` field and rolled up in **Settings → Cost** by project + total.

## Development

### Project layout (high level)

```
src/
├── app/api/…           # Next.js Route Handlers — server-side endpoints
├── components/         # React components (LeftPanel, MiddlePanel, RightPanel/*)
├── lib/
│   ├── api-types.ts        # Typed contract shared FE ↔ BE
│   ├── client/             # FE-only client (api-client, hooks, helpers)
│   ├── http/               # Route guards (withCsrf, withRequestLog, errors)
│   ├── jobs/               # In-memory job queue + journal
│   ├── llm/                # LLM client interface + prompts + services
│   ├── projects/           # Project add / lookup / refresh
│   ├── reports/            # MD + HTML renderers (downloads)
│   ├── scanners/           # Registry, CVE, code, resolver, endoflife
│   └── storage/            # Atomic JSON, envelope, canonical writer
└── instrumentation.ts  # (deferred — see spec §5.1.1)

tests/
├── backend/            # Vitest integration tests against sandboxed library/
├── frontend/           # Vitest + React Testing Library
└── e2e/                # Playwright UI smoke

scripts/setup.mjs       # Interactive .env + _config.json bootstrap

```

### `MOCK_LLM` for iteration without API spend

Set `MOCK_LLM=true` in `.env` and seed fixture files in `test-fixtures/llm/`. Every LLM call is intercepted, keyed by a SHA hash of (system prompt + user prompt + tool schema + model), and replied to from the fixture. Missing fixtures throw a clear error pointing at the expected filename, so you can drop a fixture into the right place and continue iterating.

### Running tests

```bash
npm test                 # Full Vitest suite (unit + integration with MOCK_LLM)
npm run test:watch       # Iterative dev loop
npm run test:e2e         # Playwright UI smoke tests
```

The full suite runs in ~7 seconds; tests are deterministic and run against per-test sandboxed `library/` directories (no developer-state leakage). One nightly CI job can be configured to run the integration suite against the real LLM for prompt regression — that requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and unset `MOCK_LLM`.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `npm run dev` Watchpack `EINVAL` on `C:\hiberfil.sys` or similar | Next.js workspace-root detection landed too high. `next.config.mjs`'s `experimental.outputFileTracingRoot: __dirname` + `webpack.watchOptions.ignored` cover this — both must be present (they are, in the shipped config). |
| `npm run build` errors like `UnhandledSchemeError: Reading from "node:fs"…` | All source files use bare specifier imports (`from 'fs'`) — `node:`-prefixed imports break Webpack's static analysis in 14.2.x. Sweep your patches before committing. |
| `Invalid CSRF token` after restart | The CSRF token rotates on every server restart. Reload the browser tab. |
| "Job no longer tracked by the server" | The server restarted mid-job. Re-trigger from the affected view. |
| `_logs/server.log` not updating | Run `tail -f library/_logs/server.log` to confirm — the v0.5 logger appends synchronously per line. If still empty, check `LOG_LEVEL` and the `withRequestLog` wrapping for the affected route. |
| Phase 2 scan hangs | Open `library/_logs/server.log` — phase-boundary logs (`phase2 registry done`, `phase2 OSV done`, `phase2 envelope writes done`, `phase2 flush done`, `phase2 complete`) tell you exactly which stage. A per-job watchdog also emits a warn line every 30 s with `runningForMs`. |
| Volta-pinned `node` / `npm` / `yarn` shows "version unknown" in some view | Make sure `project.volta` is populated in your target's `package.json`. The agent synthesises Volta toolchain entries client-side AND on the BE via `findProjectDep` (§10.4.1). |



## License

MIT (or your project's preferred license — update this section as needed).
