const core = require('@actions/core');
const github = require('@actions/github');
const artifact = require('@actions/artifact');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const MARKER = '<!-- ci-canary-pr-gate:comment -->';

function asBool(s, def) {
  if (s === undefined || s === null || s === '') return def;
  return String(s).toLowerCase() === 'true';
}

function asNumberOrNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

function fmtDelta(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  // keep readable; do not over-format (users can control in their report)
  return `${sign}${n}`;
}

function minimalValidateReport(report, label) {
  const where = label ? ` (${label})` : '';
  if (!report || typeof report !== 'object') throw new Error(`Report${where} is not an object`);
  if (typeof report.version !== 'number') throw new Error(`Report${where}.version must be a number`);
  if (!report.summary || typeof report.summary !== 'object') throw new Error(`Report${where}.summary missing`);
  if (typeof report.summary.score !== 'number') throw new Error(`Report${where}.summary.score must be a number`);
  if (typeof report.summary.passed !== 'boolean') throw new Error(`Report${where}.summary.passed must be a boolean`);
  if (!Array.isArray(report.scenarios)) throw new Error(`Report${where}.scenarios must be an array`);
  for (const [i, s] of report.scenarios.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`Report${where}.scenarios[${i}] must be an object`);
    if (typeof s.id !== 'string' || !s.id) throw new Error(`Report${where}.scenarios[${i}].id must be a non-empty string`);
    if (typeof s.passed !== 'boolean') throw new Error(`Report${where}.scenarios[${i}].passed must be a boolean`);
  }
}

async function readJsonFile(p, label) {
  const raw = await fsp.readFile(p, 'utf8');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${label || p}: ${e.message}`);
  }
  minimalValidateReport(obj, label || p);
  return obj;
}

function runShellCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code, signal) => {
      resolve({ code: code ?? 0, signal: signal ?? null });
    });
  });
}

function refToBranch(ref) {
  if (!ref) return undefined;
  const m = String(ref).match(/^refs\/heads\/(.+)$/);
  if (m) return m[1];
  return undefined;
}

async function resolveWorkflowId(octokit, owner, repo, baselineWorkflow) {
  const trimmed = String(baselineWorkflow || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // Name or file name
  const { data } = await octokit.rest.actions.listRepoWorkflows({ owner, repo, per_page: 100 });
  const wf = (data.workflows || []).find((w) => w.name === trimmed || w.path.endsWith(`/${trimmed}`) || w.path === trimmed);
  return wf ? wf.id : null;
}

async function downloadBaselineArtifact({ octokit, owner, repo, artifactName, workflowId, baselineRef, desiredReportBasename }) {
  const branch = refToBranch(baselineRef);
  const runsResp = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowId,
    per_page: 20,
    status: 'completed',
    ...(branch ? { branch } : {}),
  });
  const runs = (runsResp.data.workflow_runs || []).filter((r) => r.conclusion === 'success');
  const run = runs[0];
  if (!run) return null;

  const artsResp = await octokit.rest.actions.listWorkflowRunArtifacts({ owner, repo, run_id: run.id, per_page: 100 });
  const art = (artsResp.data.artifacts || []).find((a) => a.name === artifactName);
  if (!art) return null;

  const dl = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: art.id,
    archive_format: 'zip',
  });

  const buf = Buffer.from(dl.data);
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-canary-pr-gate-'));
  const zipPath = path.join(tmpDir, `${artifactName}.zip`);
  await fsp.writeFile(zipPath, buf);

  const zip = new AdmZip(zipPath);
  const extractDir = path.join(tmpDir, 'unzipped');
  await fsp.mkdir(extractDir, { recursive: true });
  zip.extractAllTo(extractDir, true);

  // Search for report file.
  const candidates = [];
  async function walk(d) {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else candidates.push(p);
    }
  }
  await walk(extractDir);

  let chosen = null;
  if (desiredReportBasename) {
    chosen = candidates.find((p) => path.basename(p) === desiredReportBasename);
  }
  if (!chosen) {
    chosen = candidates.find((p) => p.toLowerCase().endsWith('.json'));
  }
  if (!chosen) return null;

  const baseline = await readJsonFile(chosen, `baseline artifact ${artifactName}/${path.basename(chosen)}`);
  return {
    baseline,
    meta: {
      workflowRunId: run.id,
      workflowRunHtmlUrl: run.html_url,
      artifactId: art.id,
      artifactName,
      chosenPath: chosen,
    },
  };
}

function computeDiff(report, baseline) {
  if (!baseline) return null;
  const scoreDelta = report.summary.score - baseline.summary.score;
  const metricDeltas = {};
  const reportMetrics = report.metrics && typeof report.metrics === 'object' ? report.metrics : {};
  const baseMetrics = baseline.metrics && typeof baseline.metrics === 'object' ? baseline.metrics : {};

  const keys = new Set([...Object.keys(reportMetrics), ...Object.keys(baseMetrics)]);
  for (const k of keys) {
    const a = reportMetrics[k];
    const b = baseMetrics[k];
    if (typeof a === 'number' && typeof b === 'number') metricDeltas[k] = a - b;
  }
  return { scoreDelta, metricDeltas };
}

function evaluateGate({ report, baseline, diff, inputs, commandResult }) {
  const reasons = [];

  if (commandResult && commandResult.code !== 0 && inputs.failOnCommandError) {
    reasons.push(`command failed (exit ${commandResult.code})`);
  }

  const scenarios = report.scenarios || [];
  const failedScenarios = scenarios.filter((s) => s && s.passed === false);
  if (inputs.failOnAnyScenarioFail && failedScenarios.length > 0) {
    reasons.push(`${failedScenarios.length} scenario(s) failed`);
  }

  if (inputs.minScore !== null && report.summary.score < inputs.minScore) {
    reasons.push(`score below min_score (${report.summary.score} < ${inputs.minScore})`);
  }

  if (inputs.maxScoreDrop !== null) {
    if (!baseline || !diff) {
      // informational only
    } else {
      const drop = baseline.summary.score - report.summary.score;
      if (drop > inputs.maxScoreDrop) {
        reasons.push(`score drop exceeded max_score_drop (${drop} > ${inputs.maxScoreDrop})`);
      }
    }
  }

  if (inputs.maxMetricRegressions && Object.keys(inputs.maxMetricRegressions).length > 0) {
    if (!baseline || !diff) {
      // informational only
    } else {
      for (const [k, thr] of Object.entries(inputs.maxMetricRegressions)) {
        const delta = diff.metricDeltas[k];
        if (typeof delta !== 'number') continue;
        if (delta > thr) reasons.push(`metric regression: ${k} increased by ${delta} (threshold ${thr})`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons, failedScenariosCount: failedScenarios.length };
}

function renderComment({ title, gate, report, baseline, diff, artifactName, reportPath, inputs, baselineMeta }) {
  const status = gate.passed ? '✅ PASS' : '❌ FAIL';
  const score = report.summary.score;
  const failed = gate.failedScenariosCount;
  const total = (report.scenarios || []).length;

  const lines = [];
  lines.push(MARKER);
  lines.push('');
  lines.push(`## ${title} — ${status}`);
  lines.push('');
  lines.push(`**Score:** ${score}  `);
  lines.push(`**Scenarios:** ${total} total, ${failed} failed`);

  if (!gate.passed) {
    lines.push('');
    lines.push('### Failure reasons');
    for (const r of gate.reasons) lines.push(`- ${r}`);
  }

  const baselineLabel = inputs.baselinePath
    ? path.basename(inputs.baselinePath)
    : inputs.baselineArtifact
      ? `${inputs.baselineArtifact}${baselineMeta?.workflowRunHtmlUrl ? ` ([run](${baselineMeta.workflowRunHtmlUrl}))` : ''}`
      : '';

  if (inputs.baselinePath || inputs.baselineArtifact) {
    lines.push('');
    lines.push(`### Baseline comparison${baselineLabel ? ` (${baselineLabel})` : ''}`);
    if (!baseline || !diff) {
      lines.push('- Baseline not found; skipping regression checks');
    } else {
      lines.push(`- Score delta: **${fmtDelta(diff.scoreDelta)}**`);

      // Metric section
      const thresholds = inputs.maxMetricRegressions || {};
      const metricRows = [];
      const metricDeltas = diff.metricDeltas || {};

      const keys = Object.keys(thresholds).length > 0
        ? Object.keys(thresholds)
        : Object.keys(metricDeltas);

      for (const k of keys) {
        const delta = metricDeltas[k];
        if (typeof delta !== 'number') continue;
        const thr = thresholds[k];
        let badge = '';
        if (typeof thr === 'number') badge = delta > thr ? ' ❌' : ' ✅';
        const thrText = typeof thr === 'number' ? ` (threshold: ${fmtDelta(thr)})` : '';
        metricRows.push({ k, delta, line: `  - ${k}: ${fmtDelta(delta)}${thrText}${badge}` });
      }
      metricRows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      if (metricRows.length > 0) {
        lines.push('- Top metric deltas:');
        for (const row of metricRows.slice(0, 5)) lines.push(row.line);
      }
    }
  }

  // Worst scenarios (by score if available)
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const worst = scenarios
    .filter((s) => s && s.passed === false)
    .slice(0, 5);
  lines.push('');
  lines.push('### Worst scenarios');
  if (worst.length === 0) {
    lines.push('- (none)');
  } else {
    for (const s of worst) {
      const scoreText = typeof s.score === 'number' ? ` score=${s.score}` : '';
      const notesText = s.notes ? ` — ${String(s.notes).slice(0, 140)}` : '';
      lines.push(`- ${s.id}:${scoreText}${notesText}`);
    }
  }

  lines.push('');
  lines.push(`**Artifact:** \`${artifactName}\` → \`${path.basename(reportPath)}\``);

  const linkBits = [];
  if (inputs.dashboardUrl) linkBits.push(`[SLO burn dashboard](${inputs.dashboardUrl})`);
  if (inputs.healthAlertsUrl) linkBits.push(`[Run health alerting](${inputs.healthAlertsUrl})`);
  if (linkBits.length > 0) {
    lines.push('');
    lines.push(`Links: ${linkBits.join(' · ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

async function upsertPrComment({ octokit, owner, repo, issueNumber, body, mode }) {
  if (mode === 'off') return { didComment: false };

  if (mode === 'create') {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    return { didComment: true, updated: false };
  }

  // create-or-update
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return { didComment: true, updated: true };
  }

  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  return { didComment: true, updated: false };
}

async function main() {
  const inputs = {
    command: core.getInput('command', { required: true }),
    reportPath: core.getInput('report_path') || 'eval-report.json',
    artifactName: core.getInput('artifact_name') || 'ci-canary-report',
    retentionDays: Number(core.getInput('retention_days') || '14'),

    commentMode: (core.getInput('comment_mode') || 'create-or-update').trim(),
    commentTitle: core.getInput('comment_title') || 'CI Canary',
    githubToken: core.getInput('github_token') || process.env.GITHUB_TOKEN,

    baselinePath: (core.getInput('baseline_path') || '').trim(),
    baselineArtifact: (core.getInput('baseline_artifact') || '').trim(),
    baselineWorkflow: (core.getInput('baseline_workflow') || '').trim(),
    baselineRef: (core.getInput('baseline_ref') || 'refs/heads/main').trim(),

    failOnCommandError: asBool(core.getInput('fail_on_command_error'), true),
    failOnAnyScenarioFail: asBool(core.getInput('fail_on_any_scenario_fail'), true),
    minScore: asNumberOrNull(core.getInput('min_score')),
    maxScoreDrop: asNumberOrNull(core.getInput('max_score_drop')),
    maxMetricRegressionsJson: (core.getInput('max_metric_regressions_json') || '').trim(),

    dashboardUrl: (core.getInput('dashboard_url') || '').trim(),
    healthAlertsUrl: (core.getInput('health_alerts_url') || '').trim(),
  };

  let maxMetricRegressions = null;
  if (inputs.maxMetricRegressionsJson) {
    try {
      const obj = JSON.parse(inputs.maxMetricRegressionsJson);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('expected a JSON object/map');
      }
      maxMetricRegressions = {};
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        maxMetricRegressions[k] = n;
      }
    } catch (e) {
      throw new Error(`Invalid max_metric_regressions_json: ${e.message}`);
    }
  }
  inputs.maxMetricRegressions = maxMetricRegressions;

  const reportAbs = path.resolve(process.cwd(), inputs.reportPath);

  // 1) run command
  core.info(`Running command: ${inputs.command}`);
  const commandResult = await runShellCommand(inputs.command);

  // 2) read + validate report
  if (!fs.existsSync(reportAbs)) {
    // If the command failed, we still want a helpful failure.
    throw new Error(`report_path not found: ${reportAbs}`);
  }
  const report = await readJsonFile(reportAbs, 'report');

  // 3) load baseline (best-effort)
  let baseline = null;
  let baselineMeta = null;

  if (inputs.baselinePath) {
    const baseAbs = path.resolve(process.cwd(), inputs.baselinePath);
    if (fs.existsSync(baseAbs)) {
      baseline = await readJsonFile(baseAbs, 'baseline');
    } else {
      core.warning(`baseline_path not found: ${baseAbs}`);
    }
  } else if (inputs.baselineArtifact) {
    if (!inputs.githubToken) {
      core.warning('baseline_artifact set but github_token is empty; skipping baseline download');
    } else if (!inputs.baselineWorkflow) {
      core.warning('baseline_artifact set but baseline_workflow is empty; skipping baseline download');
    } else {
      try {
        const octokit = github.getOctokit(inputs.githubToken);
        const { owner, repo } = github.context.repo;
        const wfId = await resolveWorkflowId(octokit, owner, repo, inputs.baselineWorkflow);
        if (!wfId) {
          core.warning(`Could not resolve baseline_workflow: ${inputs.baselineWorkflow}`);
        } else {
          const desired = path.basename(inputs.reportPath);
          const downloaded = await downloadBaselineArtifact({
            octokit,
            owner,
            repo,
            artifactName: inputs.baselineArtifact,
            workflowId: wfId,
            baselineRef: inputs.baselineRef,
            desiredReportBasename: desired,
          });
          if (downloaded) {
            baseline = downloaded.baseline;
            baselineMeta = downloaded.meta;
          } else {
            core.warning('Baseline artifact not found (or no successful run available); skipping baseline diff');
          }
        }
      } catch (e) {
        core.warning(`Failed to download baseline artifact: ${e.message}`);
      }
    }
  }

  const diff = computeDiff(report, baseline);

  // 4) evaluate gate
  const gate = evaluateGate({ report, baseline, diff, inputs, commandResult });

  // 5) upload artifact
  const client = artifact.create();
  const rootDir = path.dirname(reportAbs);
  await client.uploadArtifact(inputs.artifactName, [reportAbs], rootDir, {
    retentionDays: Number.isFinite(inputs.retentionDays) ? inputs.retentionDays : 14,
  });

  // 6) comment (best-effort; do not gate on comment errors)
  try {
    const ctx = github.context;
    const isPr = ctx.eventName === 'pull_request' || ctx.eventName === 'pull_request_target';
    if (isPr && inputs.commentMode !== 'off') {
      const pr = ctx.payload.pull_request;
      if (!pr || !pr.number) {
        core.warning('pull_request context missing; cannot comment');
      } else if (!inputs.githubToken) {
        core.warning('github_token empty; cannot comment');
      } else {
        const octokit = github.getOctokit(inputs.githubToken);
        const { owner, repo } = ctx.repo;
        const body = renderComment({
          title: inputs.commentTitle,
          gate,
          report,
          baseline,
          diff,
          artifactName: inputs.artifactName,
          reportPath: reportAbs,
          inputs,
          baselineMeta,
        });
        await upsertPrComment({ octokit, owner, repo, issueNumber: pr.number, body, mode: inputs.commentMode });
      }
    }
  } catch (e) {
    core.warning(`Failed to post/update PR comment: ${e.message}`);
  }

  // 7) outputs
  core.setOutput('passed', String(gate.passed));
  core.setOutput('score', String(report.summary.score));
  core.setOutput('score_delta', diff ? String(diff.scoreDelta) : '');
  core.setOutput('failed_scenarios', String(gate.failedScenariosCount));
  core.setOutput('report_path', reportAbs);
  core.setOutput('artifact_name', inputs.artifactName);

  if (!gate.passed) {
    core.setFailed(gate.reasons.join('; '));
  }

  // If command failed but fail_on_command_error=false, still expose it.
  if (commandResult.code !== 0) {
    core.info(`Command exit code: ${commandResult.code}`);
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
