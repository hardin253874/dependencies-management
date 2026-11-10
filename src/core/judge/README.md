# `src/core/judge` — Jev (TypeSafe) judgments (v2 Stage 5b)

Design contract: `Plans/V2_STAGE5_SPEC.md` §4 and the J1–J8 table in `Plans/V2_UPGRADE_PLAN.md`. This folder follows the core boundary: no Next or React, relative imports only, and no module-scoped mutable state.

| File | What it holds |
|---|---|
| `types.ts` | `JudgeUse` (`router`, `J1` … `J8`), `USE_CLASS` (the data each use sends), the `JudgeSwitches` shape and its normalizer, the answer shapes, `JudgePrivacyError` (refused) and `JudgeUnavailableError` (no key or outage) |
| `payload.ts` | The class-checked builders `metadataPayload`, `publicTextPayload` and `sourcePayload`, the snippet caps (40 lines / 2 KB), the request bound (48k), and `requestBoundTokens` |
| `privacy.ts` | `assertAllowed`: the switches, the per-project off switch, private eval cases, the payload class, and private or not-set projects (J1–J3 are allowed only with `sourceOptIn`) |
| `constants.ts` | `JEV_MODEL = 'jev-1.14.0'`, the base URL, `JEV_TIMEOUT_MS` (8 s per request), `ROUTER_TIMEOUT_MS` (3 s) and `JEV_USE_DEADLINE_MS` (10 s for all requests of one use in one job) |
| `client.ts` | The `JudgeClient` seam. `TypeSafeJudgeClient` passes every option explicitly, sets `maxRetries: 0` and `compression: false`, and does reserve → `systemOne` → settle. `unavailableFrom` maps SDK errors to a reason |
| `mock.ts` | `MockJudgeClient`. It answers from a responder or from `test-fixtures/judge/<use>.json`, records every request, and simulates `timeout` / `429` / `529` / `401` / `connection` / `hang` |
| `cache.ts` | `JudgeCache` (files are envelopes named by payload hash) and its in-flight dedupe. The key includes `JUDGE_PROMPT_VERSION` |
| `ledger.ts` | `JevLedger` with a HARD $0.50 cap (`JEV_CAP_USD`) and the `JEV_PRICES` table. `sessionGate` is for the eval; `perOperationGate` is for the app |
| `judge.ts` | `Judge.ask` / `tryAsk`: guard → no client? → cache → client, with a timeout race |
| `uses.ts` | J1 to J8: the question builders and how their answers are read (Noul 0.7 / 0.3, Choice confidence < 0.5 means do not act). Every ask goes through a `JudgeBreaker` (`createJudgeBreaker`; the app puts one on each `JudgeContext`): the first `unavailable` answer stops the rest of the loop, and each request's timeout is capped by what is left of the 10 s deadline. A privacy refusal of one item does not trip it |

The router lives next to the other LLM code, in `src/core/llm/router.ts`: `routeRules` (pure), `routeModel` (rules, then Jev), and `decisionFromJev` (shared with the eval's router arms).

## Invariants

- **One path to TypeSafe: through `Judge`.** Only `TypeSafeJudgeClient` builds a `TypeSafeClient`. In the eval, only `eval/lib/real.ts` builds a `TypeSafeJudgeClient`.
- **A refusal or an outage never reaches the user as an error.** The caller keeps today's output.
- **Switch off means the call site does not call Jev at all.** The app gets `null` from `judgeContextFor`, so its output is byte-identical to before Stage 5b.
- **Real requests always go through the Jev ledger: reserve first, then settle.** The mock skips the ledger.
