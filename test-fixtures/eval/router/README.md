# Router-arm fixtures (v2 Stage 5b.16)

Synthetic, id-free numbers for `eval/lib/router-arms.ts` tests: three
`v2-agent` result files (`opus.json`, `sonnet.json`, `haiku.json`) over three
synthetic public cases (`cases.json`). Not measurements; no real repo.

| case | phase jump | base files | truth | Opus tp/cost | Sonnet tp/cost | Haiku tp/cost |
|---|---|---|---|---|---|---|
| synthetic-major (complex) | major | 300 | 100 | 90 / 0.40 | 88 / 0.20 | 80 / 0.02 |
| synthetic-patch (control) | patch | 10 | 10 | 9 / 0.10 | 9 / 0.05 | 9 / 0.005 |
| synthetic-minor (complex) | minor | 50 | 50 | 45 / 0.30 | 44 / 0.15 | 40 / 0.015 |

Rules: major/300 files → Opus, patch/10 files → Haiku, minor/50 → unclear.
