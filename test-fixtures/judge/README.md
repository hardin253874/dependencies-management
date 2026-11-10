# Mock Jev fixtures (v2 Stage 5b.2)

`MOCK_LLM=true` answers every Jev request from `MockJudgeClient` (no network,
no ledger). `<use>.json` (`router`, `J1` … `J8`) is optional; missing = the
type defaults (choice: first label, confidence 0.9; score: 0; noul: 0.5).

Shape: `{ "answers": { "<question name>": <answer> }, "fallback": { "choice": { "choice": "...", "confidence": 0.9 }, "score": { "score": 2 }, "noul": { "noul": 0.8 } } }`.
