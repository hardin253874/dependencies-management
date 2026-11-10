# src/core/agent — read-only investigator (v2 Stage 4a, L2)

The bounded agent loop behind the [D] Update Report and [D-Deep] Deep Report,
and the read-only tool set it explores the project with. Contract:
`V2_STAGE4_SPEC.md` §2–§3 and `V2_AI_OVER_GRAPH.md` (planning vault, outside
the repo). Runtime: our own manual tool loop on `@anthropic-ai/sdk` 1.x
(proposed D24, D8's documented fallback); tools are MCP-first, so the Stage 4b
MCP server and a later Agent SDK runtime (D9) reuse them unchanged.

## Rules

- **Core boundary (D1/D23):** no Next/React, relative imports only, no
  module-scoped mutable state. Imports from `src/lib` are type-only or pure
  (`LLMError` from `lib/llm/client.ts`, types from `lib/llm/{cost,effort}.ts`,
  the envelope helpers in `core/intel/apiDiff.ts`). Pricing is injected into
  `runAgent`.
- **Read-only (D7):** every tool declares `capability: 'read'`; the registry
  throws on anything else (`invariant.readonly-tools.test.ts`). Tools take
  `workspaceRoot` from their context, never `project.path`. They only call
  `realpath` / `readFile` under the root, never open `.env*`, never execute
  target code. `api_diff` reads registry tarballs in memory only.
- **No real API in 4a:** tests use `ScriptedAgentModel` or a fake
  `AnthropicLike`; the app uses `test-fixtures/agent/<scenario>.json` under
  `MOCK_LLM=true`.

## Module map

| File | Role |
|---|---|
| `types.ts` | `AgentToolDef`, `TerminalToolDef`, `ToolContext`, `IntelContext`, `ToolResult`, `ToolError`, schema subset types |
| `schema.ts` | Strict-subset check for tool schemas, input validator, API schema (local-only bounds stripped) |
| `registry.ts` | `createToolRegistry` (capability guard), `call` (validate → handler → safe error → size cap), `truncateToolResult`, `toAnthropicTools` (sorted, terminal last, `strict: true`) |
| `pathGuard.ts` | `normalizeRelPath` (string checks before any fs call) + `pathGuard` (graph file set / `package.json` allow-list, realpath containment) |
| `tools/graph.ts` | Graph tools over `core/graph/query.ts` (paginated `{ items, total, nextOffset }`) |
| `tools/files.ts` | `read_file`, `search_code` (literal search) |
| `tools/apiDiff.ts` | `api_diff` joined to usage sites (uses `core/intel/apiDiff.ts`) |
| `tools/peers.ts` | `peer_requirements` |
| `tools/index.ts` | `readToolDefs()` / `createReadToolRegistry()` — the one tool list |
| `model.ts` | `AgentModel` seam (SDK types), `ScriptedAgentModel`, script file shape |
| `loop.ts` | `runAgent`: budgets, projection, final turn, cancel, trace, spend-gate seam |
| `budgets.ts` | Default budgets per view, derived `maxUsd`, config normalization |
| `seedFacts.ts` | Seed facts (graph summary, usage counts, base-set counts, api_diff lines) + reported-path normalization / graph filter |
| `impactBase.ts` | Stage 5a: `impactBaseSet` (graph base impacted set, the v2-graph rule) + `impactOverlay` (agent rank / add / exclude on top) |
| `playbooks.ts` | Playbook front matter, matching, seed block, loader for `playbooks/*.md` |

App wiring lives in `src/lib/agent/` (run records, factory, registry intel,
job helpers) and `src/lib/llm/agent*.ts` (the [D] / [D-Deep] services, the
Anthropic model, the estimate). The eval predictor is `eval/lib/predict-agent.ts`.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `graph_summary` | — | counts by category/kind, packages, edges, unresolved, entry points (≤ 50) |
| `files_using_package` | `pkg`, `transitive?`, `wrapper_depth?` (0–5), `limit?` (1–200, default 50), `offset?` | file hits with `via`, `viaPath`, `depth`, `confidence` |
| `symbols_used` | `pkg`, paging | used exports (symbol + member) with counts |
| `usage_sites` | `pkg`, `symbol?`, `member?`, paging | call / JSX / member sites with snippet + confidence |
| `dependents` | `file`, `depth?` (1–5, default 3), paging | reverse import closure |
| `affected_entry_points` | exactly one of `pkg` / `file`, paging | reached entry points (pages, routes, main) |
| `tests_covering` | `files[]` (≤ 100), paging | test files whose closure reaches them |
| `wrappers` | `pkg`, paging | files importing the package and exporting something |
| `unresolved_imports` | paging | unresolved edges + summary |
| `read_file` | `path`, `start_line?`, `end_line?` | ≤ 400 numbered lines / 32 KB; graph files and `package.json` only |
| `search_code` | `query` (literal, ≥ 2 chars), `path_prefix?`, `file_kinds?`, `case_sensitive?`, `limit?` (≤ 200) | path + line + snippet (≤ 200 chars); ≤ 2,000 files read, files > 2 MB skipped |
| `api_diff` | `pkg`, `from`, `to` | removed / signature-changed (each with ≤ 20 usage sites + total) / added / rename candidates, or `{ status: 'unavailable', reason }` |
| `peer_requirements` | `pkg`, `version` | target version's peers vs declared range + installed version |

Every result is capped (16 KB default, 48 KB for `read_file`) with an explicit
`[TRUNCATED …]` marker. Unknown package / file → empty result. Invalid input,
unknown tool and handler failures → `is_error` with a stable message (no
stack, absolute paths redacted).

## Budget semantics (all hard, per run)

`maxToolCalls`, `maxInputTokens` (uncached + cache read + cache write over all
turns), `maxOutputTokens`, `maxWallMs`, `maxUsd` (from API-reported usage),
plus `perTurnMaxTokens`. Defaults: [D] 20 / 400k / 16k / 180 s / derived,
[D-Deep] 40 / 1M / 40k / 300 s / derived (`budgets.ts`; `_config.json`
`agentBudgets`, read-only in the UI).

Before every request the loop projects its worst case and does not send it if
it could pass a budget:

- input tokens ≤ `ceil(utf8Bytes(system + tools + messages) / 2)`;
- price: the part sent last turn at cache-read once the API has reported
  caching in this run, the rest at the 5-minute cache-write price (≥ uncached);
  output = this request's `max_tokens`;
- a normal turn is sent only if it AND a same-size final turn fit; output keeps
  a reserve of min(`perTurnMaxTokens`, `maxOutputTokens` / 4).

When a budget is reached (tool calls, tokens, USD, or 80 % of wall time) the
loop appends "Budget reached. Call `<submit>` now…" to the pending user message
(tool list unchanged, so the cached prefix stays valid; forced `tool_choice` is
a 400). Other tool calls then get `is_error: budget exhausted`; one more turn is
allowed, then `budget-exhausted`. Text-only answers get one nudge, then
`no-submit`. A submit cut at `max_tokens` → `error` (`LLM_TRUNCATED`); refusal →
`LLM_REFUSAL`. Cancel aborts the in-flight request; the trace is kept. The hard
wall-time limit aborts an in-flight request. Known limit: a cache miss after
caching was seen can make one request cost more than projected; the 4c spend
gate prices every request at the uncached price, so its cap still holds.

## Impacted files: base set + agent overlay (Stage 5a, proposed D29)

The [D] report's impacted files start from the graph, not from what the agent
happened to inspect (Stage 4c measured the agent at complex recall 0.068 vs
v2-graph 0.713 because only `filesToModify` was scored).

- **Base set** = `impactBaseSet(graph, packages)`: every
  `filesUsingPackage(…, { transitive: true, wrapperDepth: 1 })` hit except a
  non-JS file reached via `reexport` — the `eval/lib/predict-graph.ts` rule, no
  new SQL. Deduplicated over packages (best via wins), path ascending, each item
  with `via`, `kind`, `confidence`, `packages[]`. `impact-base.test.ts` proves
  it equals `predictV2Graph` on fixtures.
- **Seed**: only the counts (`impactBaseLines`: totals by via/kind, one line per
  package), never the list (superset has 1,352 files). The agent is told the set
  is already in the report and asked to rank, add, and exclude with evidence.
- **Terminal tool** (`AGENT_UPDATE_REPORT_TOOL_SCHEMA`): the v1
  `UPDATE_REPORT_TOOL_SCHEMA` spread (v1 object untouched) + a REQUIRED
  `excludeFiles: [{ path, evidence }]` (required, so the strict-schema optional
  param count does not grow; may be empty).
- **`readPaths`** (`AgentRunResult`, run record): normalized paths of every
  successful `read_file` call (insertion order, deduped, cap `READ_PATHS_MAX` =
  500). Refused / failed reads are not in it. No effect on budgets or requests.
- **Overlay** (`impactOverlay`): `filesToModify` (after the graph-file filter)
  in the agent's order gives the rank; a ranked base file is `confirmed`, a
  ranked non-base graph file is `added` (`origin: 'agent'`); hallucinated paths
  are dropped and counted as before. An exclusion is valid only for a base file
  that is in `readPaths` and not also ranked; any other exclusion is rejected
  (file kept, `rejectedExclusions`). Excluded files stay in the list with
  `agent: 'excluded'` + evidence.
- **Full set** = base ∪ added − valid excluded (what the eval `v2-agent`
  predictor scores); **subset** = confirmed ∪ added (`v2-agent:subset`). A run
  that does not submit gives the base set (the deterministic-partial envelope
  carries it).

## Tests

`tests/backend/agent/**` (registry, tools, path guard, read-only invariant,
model, loop incl. a 200-seed budget property check, run store, services,
routes, playbooks, config), `tests/backend/intel/apiDiff.test.ts`,
`tests/backend/eval/{agent,v1-ai}-predict.test.ts`, `tests/frontend/AgentRun.test.tsx`.
