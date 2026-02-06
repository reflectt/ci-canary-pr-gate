# ci-canary-pr-gate

A thin, infra-free GitHub Action to:

- run a repo-defined canary/eval command
- verify a canonical JSON report exists at `report_path`
- upload the report as a workflow artifact
- optionally diff against a baseline (repo file or artifact from `main`)
- (on PRs) post/update a summary PR comment (with a hidden marker)
- optionally fail CI when thresholds are exceeded

This is the 1-day MVP implementation described in `DEFINE.md` / `DESIGN.md` (in the parent workspace).

## Action interface

See [`action.yml`](./action.yml) for all inputs/outputs.

Minimal inputs:

- `command` (required)
- `report_path` (default: `eval-report.json`)

## Report JSON schema (minimal required)

Your `command` must write a JSON file at `report_path` with at least:

- `version` (number)
- `summary.score` (number)
- `summary.passed` (boolean)
- `scenarios[]` with items `{ id: string, passed: boolean, ... }`

## Example: PR gate (baseline committed in repo)

```yaml
name: CI Canary (PR)

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run canary + gate PR
        uses: reflectt/ci-canary-pr-gate@v0
        with:
          command: node ./scripts/run-canary.js
          report_path: eval-report.json
          baseline_path: eval-baseline.json
          min_score: "0.95"
          max_score_drop: "0.02"
          comment_mode: create-or-update
```

## Example: PR gate using baseline artifact from scheduled `main`

```yaml
permissions:
  contents: read
  actions: read
  pull-requests: write

- name: Run canary (diff vs baseline)
  uses: reflectt/ci-canary-pr-gate@v0
  with:
    command: node ./scripts/run-canary.js
    report_path: eval-report.json
    baseline_artifact: canary-baseline
    baseline_workflow: CI Canary (Baseline)
    baseline_ref: refs/heads/main
    max_score_drop: "0.02"
    comment_mode: create-or-update
```

## Notes

- Comment posting is **best-effort** (it will warn on permission issues but will not fail the job).
- Baseline download is **best-effort** (missing baseline does not fail CI by itself).

## License

MIT
