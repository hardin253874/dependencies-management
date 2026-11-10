# Agent scripts (MOCK_LLM for the agent loop)

`MOCK_LLM=true` answers agent runs ([D] / [D-Deep] with `llm.reportEngine: 'agent'`, and the eval
`v2-agent` predictor with `--mock-script`) from a **scripted model** instead of the API
(`ScriptedAgentModel`, `src/core/agent/model.ts`).

Why scenarios and not prompt hashes (like `test-fixtures/llm/`): a run is many requests, and
each request contains every earlier tool result, so a hash per request breaks as soon as a
tool result changes by one byte.

- File: `test-fixtures/agent/<scenario>.json`. The app uses the scenario `MOCK_AGENT_SCENARIO`
  when that env var is set, else the view id (`update-report` / `deep-report`).
- Shape (`AgentScriptFile`):

```json
{
  "scenario": "update-report",
  "description": "what the run does",
  "turns": [
    { "content": [{ "type": "tool_use", "name": "graph_summary", "input": {} }], "usage": { "inputTokens": 3000, "outputTokens": 120 } },
    { "content": [{ "type": "tool_use", "name": "submit_update_report", "input": { "...": "..." } }] },
    { "error": { "code": "LLM_RATE_LIMIT", "message": "scripted failure" } }
  ]
}
```

- Block types: `text`, `thinking` (`thinking` + `signature`), `tool_use` (`name`, `input`,
  optional `id`). `stopReason` defaults to `tool_use` when a tool is called, else `end_turn`;
  set it to test `max_tokens`, `refusal`, `model_context_window_exceeded`.
- `usage` defaults to 1,000 input / 200 output tokens. Costs are computed from it with
  `src/lib/llm/cost.ts`, exactly like real usage.
- A script that runs out throws `MOCK_LLM_NO_FIXTURE` (never a silent default).
- Since Stage 5a the [D] terminal tool requires `excludeFiles` (may be `[]`); a
  `submit_update_report` input without it fails validation and the run never submits.
- `eval-submit-empty.json` / `eval-submit-unread-exclusions.json`: the Stage 5a.8
  offline recall check (`run --predictor v2-agent --mock-script …`).
- Fixtures must be synthetic: never paste data from a private case
  (`visibility: 'private'` / `corpus.local.json`) or real API output here.
