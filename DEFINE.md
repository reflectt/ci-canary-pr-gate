# DEFINE — CI Canary + PR Gate (GitHub Action)

Project: `ci-canary-pr-gate`

## 0) One-liner
A **local-first GitHub Action** that runs canary/eval checks on `pull_request` (and optionally `schedule`), uploads a **JSON report artifact**, and posts/updates a **PR comment summary**; it can **fail the check** when regressions exceed thresholds.

## 1) Problem
We have canary/eval code that can be run locally (notably `projects/scheduled-canary-runs`), but there’s no thin, repeatable way to:

- run it automatically in GitHub Actions for PRs
- make results visible in the PR itself
- gate merges on objective regression rules
- keep it **infra-free** (no hosted service required)

Today regressions are often detected after merge (or via ad-hoc manual runs), which is too late.

## 2) Users + user stories
### Primary users
- Repo maintainers shipping an agent/tooling who want a **merge gate**.
- PR authors who need fast feedback: “Did my change break the agent?”

### User stories
1. **PR Gate**: As a maintainer, when a PR opens/updates, I want the canary suite to run and a comment to appear with pass/fail + key metrics.
2. **Deterministic artifact**: As a maintainer, I want a machine-readable JSON artifact stored with the workflow run.
3. **Regression diff**: As a maintainer, I want the PR result compared to a baseline (main branch or a committed baseline file) and see the delta.
4. **Configurable gating**: As a maintainer, I want CI to fail when score drops, scenarios fail, or metrics exceed thresholds.
5. **Scheduled smoke** (optional for v1): As a maintainer, I want a scheduled run that generates/updates the baseline artifact.

## 3) Scope (v1 / 1-day MVP)
### In-scope
- A GitHub Action runnable on:
  - `pull_request` (primary)
  - `schedule` (secondary; enables baseline publishing)
- Runs a canary/eval command (repo-defined) and expects a JSON report at `report_path`.
- Uploads that JSON as a workflow artifact.
- Posts (or updates) a PR comment with a concise markdown summary.
- Optional baseline compare:
  - Compare to a baseline JSON file in the repo (committed), OR
  - Compare to a baseline artifact produced by a scheduled workflow on `main` (via GitHub API download).
- Failure policy:
  - fail if eval command fails
  - fail if any scenario fails (configurable)
  - fail if score regression exceeds thresholds (configurable)

### Explicit integrations (must work with what we already built)
- **`projects/scheduled-canary-runs`**
  - v1 supports running it via a command (example below).
  - v1 supports creating an action-level “adapter” that converts its JSONL output into the v1 report JSON.
  - v1 optionally uses its existing `compare` logic as a secondary signal (but the canonical output is the v1 report JSON).
- Optional (nice-to-have wiring only; no new infra):
  - `projects/agent-slo-burn-dashboard` and/or `projects/agent-run-health-alerting`
    - v1: add links to these dashboards if a URL is provided
    - v1: optionally emit a small summary JSON block they can ingest later

## 4) Non-goals (v1)
- No hosted database or web dashboard.
- No long-term run history storage beyond GitHub artifacts.
- No flake management (retries, consensus judging, etc.).
- No complex matrix orchestration (multi-os, multi-model) beyond what users can do in workflow YAML.
- No secrets management beyond standard GitHub Actions practices.

## 5) Primary deliverable
A repo-contained GitHub Action, published as one of:
- **Composite action** (fastest to ship, 1-day friendly), OR
- Node20 JS action (also fine; composite is preferred for thin-slice)

It will:
1. Run a configured command
2. Validate and parse `report_path`
3. (Optional) load baseline and compute diffs
4. Upload artifact
5. Post/patch PR comment
6. Set outputs and exit code per failure policy

## 6) Action interface (v1)
### Inputs
Required:
- `command` — shell command to run the canary/evals.

Optional (defaults in parentheses):
- `report_path` (`eval-report.json`) — where `command` writes the report JSON.
- `artifact_name` (`ci-canary-report`) — uploaded artifact name.
- `comment_mode` (`create-or-update`) — `create-or-update | create | off`.
- `comment_title` (`CI Canary`) — rendered heading.
- `github_token` (`${{ github.token }}`) — used for comment + baseline artifact download.

Baseline options (choose one):
- `baseline_path` (empty) — path to baseline JSON file in repo.
- `baseline_artifact` (empty) — artifact name to download as baseline (from `main` scheduled run).
- `baseline_workflow` (empty) — workflow file name or workflow id to locate baseline artifacts (e.g. `canary.yml`).
- `baseline_ref` (`refs/heads/main`) — ref for baseline artifact lookup.

Gating / thresholds:
- `fail_on_command_error` (`true`)
- `fail_on_any_scenario_fail` (`true`)
- `min_score` (empty) — if set, fail when `score < min_score`.
- `max_score_drop` (empty) — if set, fail when `(baseline.score - score) > max_score_drop`.
- `max_metric_regressions_json` (empty) — JSON map of metric thresholds, e.g. `{"latency_p95_ms": 500, "cost_usd": 0.10}` meaning “fail if metric increases by more than threshold vs baseline”.

Metadata / linking:
- `dashboard_url` (empty) — optional link to SLO burn dashboard.
- `health_alerts_url` (empty) — optional link to run health alerting.

### Outputs
- `passed` — `true|false` (string)
- `score` — numeric score (string)
- `score_delta` — numeric delta vs baseline (string; empty if no baseline)
- `failed_scenarios` — integer count (string)
- `report_path` — resolved path
- `artifact_name`

## 7) Workflow configuration examples

### A) PR gate (baseline committed in repo)
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

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Run canary
        uses: ./.github/actions/ci-canary-pr-gate
        with:
          command: node projects/scheduled-canary-runs/bin/scheduled-canary-runs.js run
          # Adapter step in your command should produce eval-report.json (see section 8)
          report_path: eval-report.json
          baseline_path: eval-baseline.json
          min_score: "0.95"
          max_score_drop: "0.02"
          comment_mode: create-or-update
```

### B) Scheduled baseline publisher (main)
```yaml
name: CI Canary (Baseline)

on:
  schedule:
    - cron: "0 */6 * * *"  # every 6 hours
  workflow_dispatch:

permissions:
  contents: read

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Run canary + upload baseline artifact
        uses: ./.github/actions/ci-canary-pr-gate
        with:
          command: node projects/scheduled-canary-runs/bin/scheduled-canary-runs.js run
          report_path: eval-report.json
          artifact_name: canary-baseline
          comment_mode: off
```

### C) PR gate using baseline artifact from scheduled run
```yaml
name: CI Canary (PR)

on:
  pull_request:

permissions:
  contents: read
  actions: read
  pull-requests: write

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Run canary (diff vs baseline)
        uses: ./.github/actions/ci-canary-pr-gate
        with:
          command: node projects/scheduled-canary-runs/bin/scheduled-canary-runs.js run
          report_path: eval-report.json
          baseline_artifact: canary-baseline
          baseline_workflow: CI Canary (Baseline)
          baseline_ref: refs/heads/main
          max_score_drop: "0.02"
          comment_mode: create-or-update
```

## 8) Report artifact format (JSON)
The action’s canonical artifact is a single JSON file (`report_path`) with this v1 schema.

### `eval-report.json` schema (v1)
```json
{
  "version": 1,
  "suite": "canary",
  "timestamp": "2026-02-05T23:55:00.000Z",
  "git": {
    "repo": "owner/name",
    "ref": "refs/pull/123/merge",
    "sha": "<sha>"
  },
  "summary": {
    "score": 1.0,
    "passed": true,
    "failedScenarios": 0,
    "totalScenarios": 1
  },
  "scenarios": [
    {
      "id": "openclaw-sessions-json",
      "passed": true,
      "score": 1,
      "elapsedMs": 123,
      "notes": "ok",
      "details": {}
    }
  ],
  "metrics": {
    "latency_p95_ms": 3200,
    "cost_usd": 0.47
  },
  "links": {
    "dashboard": "https://...",
    "healthAlerts": "https://..."
  }
}
```

### Baseline diff (computed by action; not required in file)
If a baseline is available, the action computes:
- `score_delta = report.summary.score - baseline.summary.score`
- `metric_deltas[k] = report.metrics[k] - baseline.metrics[k]` for numeric keys

### Adapter for `scheduled-canary-runs` (v1 expectation)
`scheduled-canary-runs` currently writes JSONL history lines like:
```json
{"timestamp":"...","scenarioId":"openclaw-sessions-json","score":1,"passFail":true,"notes":"ok","elapsedMs":123,"details":{}}
```

For v1, we support either:
- **User-provided adapter step** in the workflow/command that writes `eval-report.json`, OR
- A minimal built-in adapter mode in the action later (v1.1) that reads the last run from `projects/scheduled-canary-runs/var/canary-history.jsonl`.

Thin-slice (1-day) approach: document a tiny adapter snippet (Node one-liner) as part of examples.

## 9) PR comment template (markdown)
The action posts a comment containing a stable hidden marker so it can update in-place.

### Comment body
```md
<!-- ci-canary-pr-gate:comment -->

## CI Canary — ✅ PASS

**Score:** 0.98  
**Scenarios:** 10 total, 0 failed

### Baseline comparison (main)
- Score delta: **-0.01**
- Top metric deltas:
  - latency_p95_ms: +120ms (threshold: +500ms) ✅
  - cost_usd: +$0.03 (threshold: +$0.10) ✅

### Worst scenarios
- (none)

**Artifact:** `ci-canary-report` → `eval-report.json`

Links: [SLO burn dashboard](...) · [Run health alerting](...)
```

If the check fails, the header becomes `❌ FAIL` and the failing reasons are listed (e.g. `score below min_score`, `2 scenarios failed`, `latency_p95_ms regression`).

## 10) Failure policy (when to fail CI)
The action fails the job (exit code non-zero) when any of the following are true:

1. **Command failure**
   - `command` exits non-zero AND `fail_on_command_error=true`.
2. **Report missing/invalid**
   - `report_path` does not exist, is not valid JSON, or does not match minimal schema requirements (`version`, `summary.score`, `summary.passed`, `scenarios[]`).
3. **Scenario failures**
   - `fail_on_any_scenario_fail=true` AND any scenario has `passed=false`.
4. **Absolute threshold**
   - `min_score` set AND `summary.score < min_score`.
5. **Regression vs baseline**
   - `max_score_drop` set AND baseline exists AND `(baseline.score - score) > max_score_drop`.
   - `max_metric_regressions_json` set AND baseline exists AND any numeric metric increase exceeds its threshold.

If no baseline is available and only regression thresholds are set, the action:
- reports “baseline not found” in comment
- **does not fail** unless absolute thresholds (e.g. `min_score`) or scenario failures apply

## 11) Minimal security considerations
- Use **least-privilege permissions** in workflow:
  - PR workflows: `pull-requests: write`, `contents: read`.
  - If downloading baseline artifacts: `actions: read`.
- Treat eval reports as potentially sensitive (they may include prompts, tool outputs, URLs):
  - keep `details` small; avoid logging secrets
  - allow users to redact by controlling what the eval command writes
- Avoid executing untrusted code with secrets:
  - For PRs from forks, GitHub restricts secrets by default; the action should still work without secrets.
  - If users need API keys, recommend `pull_request_target` only with careful sandboxing (documented as **not recommended for v1**).
- GitHub token usage:
  - only for comment operations and optional artifact download
  - never print the token

## 12) Validation plan (v1)
### Local validation (developer machine)
- Run the eval command and confirm it generates a valid `eval-report.json`.
- Run the action locally via `act` (optional) or a minimal test harness script.

### Repo CI validation
Create two workflows:
1. **Baseline workflow** on `main` (schedule + manual dispatch)
   - ensures artifact upload works
2. **PR workflow** on pull_request
   - ensures comment posting/updating works
   - ensures gating works

### Test cases
- PASS case: all scenarios pass, score above min.
- FAIL case: force a scenario to fail (or score drop) and ensure:
  - job fails
  - comment shows failure reasons
- Baseline missing case: ensure no hard fail unless configured.

## 13) v2 backlog
- Built-in adapter for `scheduled-canary-runs` (no user scripting required).
- Store run history as GitHub artifacts + provide a tiny static viewer (no backend).
- Matrix support helpers (models, toolsets) with consolidated report.
- Flake controls: retries, quarantined scenarios, “soft fail” modes.
- Support richer comparison (p50/p95, budgets, percentile thresholds).
- Optional push to `agent-slo-burn-dashboard` data format or emit JSONL compatible with `agent-run-health-alerting`.
- Marketplace packaging + semantic versioning.
- Support `check-run` annotations (GitHub Checks API) for inline failure details.
