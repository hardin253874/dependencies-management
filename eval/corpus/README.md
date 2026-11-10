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
