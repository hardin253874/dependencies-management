# Eval corpus

Upgrade cases for the eval harness (`npm run eval -- --help`). Each case
pins a repo at the commit **before** an upgrade (`baseCommit`) and one or
more phase commits whose diffs are the ground truth.

## Files

| Path | Tracked | Content |
|---|---|---|
| `cases/<id>.json` | yes | One public case per file. The file name must equal the case `id`. |
| `case.schema.json` | yes | JSON Schema for editors. The validator in `eval/lib/corpus.ts` is the authority. |
| `../corpus.local.json` | **no** (gitignored) | Private cases: `{ "schemaVersion": 1, "cases": [ … ] }`. Only this file may use a local-path `repo`. |

`npm run eval -- validate` merges both sources and reports every error with
file, case id and JSON path. A case id that appears in both is an error.

## Case shape

```jsonc
{
  "id": "example-react18",                       // ^[a-z0-9][a-z0-9-]{2,60}$
  "repo": "https://github.com/<owner>/<repo>",
  "baseCommit": "<40-hex sha>",
  "projectDirs": ["."],                          // optional; repo-relative, POSIX, no ".."
  "phases": [
    {
      "id": "main",
      "toCommit": "<40-hex sha>",                // range = previous phase (or base) .. toCommit
      "packages": [ { "name": "react", "from": "17.0.2", "to": "18.2.0" } ],  // null = added/removed
      "tags": ["react-major"]                    // optional, merged with case tags
    }
  ],
  "tags": ["complex"],
  "truthExcludeGlobs": ["generated/**"],         // optional
  "source": { "pr": "https://…" },               // optional provenance
  "goldenFindings": [],                          // optional, scored by hand
  "notes": "free text"
}
```

Read `from`/`to` from the `package.json` diff printed by
`npm run eval -- truth --case <id>`; don't guess them.

## Truth rules (summary)

Kept (scored): changed source (`.js .jsx .ts .tsx .mjs .cjs`), known config
files and stylesheets under `projectDirs` that existed at the base. Dropped:
`.env*`, lockfiles, `package.json`, `truthExcludeGlobs`, snapshots, docs,
binaries, whitespace-only edits and added files. A rename counts under its
old path.

## Privacy

Private (employer/client) cases live only in `corpus.local.json`, and their
results only in `eval/results/private/`. Both are gitignored. Never put a
private case's id, repo, paths or findings in a tracked file.

## Graph measurement (`npm run eval -- graph`)

Measures the v2 code graph's answer to "which files use package X" against
an independent ground truth, plus the share of unresolved import edges.

```bash
npm run eval -- graph --label <label> [--cases a,b] [--packages declared|phase] [--offline] [--refresh-truth]
npm run eval -- run --label <label> --predictor v2-graph   # Stage 0 impacted-file metric, graph predictor
```

- **Truth** (`eval/lib/graph-truth.ts`): TypeScript 6 `preProcessFile` +
  `resolveModuleName` with the nearest `tsconfig.json`/`jsconfig.json`
  (`extends`, solution-style `references`), `allowJs` forced. Re-export
  users come from one `ts.createProgram` per projectDir (checker alias
  chains, 120 s time box). Cached at `<cache>/_graph-truth/<caseId>@<sha>.json`.
- **Graph** (`eval/lib/predict-graph.ts`): full build into
  `<cache>/_graph/<caseId>/<projectDir>.db` (never inside the clone), then
  `filesUsingPackage(pkg, { transitive: true, wrapperDepth: 1 })`.
- **Scored set**: `direct ∪ reexport`, JS/TS files only, for each package
  declared in the projectDir's `package.json` (or the phase packages with
  `--packages phase`). Reported but not scored: wrapper hits, hits only
  through a bundler alias to another name, config-ref-only hits, and
  workspace packages (the graph links them as packages; TS resolves them to
  source files).
- **Known truth limits**: TS cannot see bundler aliases, style imports or
  config references; without `node_modules` bare specifiers are attributed by
  name. The list is written into every result file.
- **Output**: `eval/results/<date>-<label>-graph.json` (public cases, with up
  to 20 graph-only/truth-only sample paths and the top unresolved
  specifiers per case); private cases go to `eval/results/private/` with
  numbers only. Targets (`recall ≥ 0.95`, `precision ≥ 0.9`, median
  unresolved ≤ 2 %) are flags in the file, never a test gate.
