/**
 * Orchestrator: Issue -> triage -> failing repro test -> fix -> critic -> PR.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RunState,
  TriageOutput,
  ReproOutput,
  FixOutput,
  CriticOutput,
  PrOutput,
} from './state.js';
import { runAgent, AgentError } from './claude.js';
import * as gates from './gates.js';
import { appendTrace, saveRaw, saveState, summarize, REPO_ROOT } from './trace.js';

const PIPELINE_DIR = path.dirname(new URL(import.meta.url).pathname);
const MAX_ATTEMPTS = 3;

/** Per-agent models */
const MODELS: Record<string, string | undefined> = {
  triage: process.env.MODEL_TRIAGE ?? undefined, // CLI default
  repro: process.env.MODEL_REPRO ?? undefined,
  fix: process.env.MODEL_FIX ?? undefined,
  critic: process.env.MODEL_CRITIC ?? 'sonnet',
  pr: process.env.MODEL_PR ?? 'haiku',
};

function git(args: string[], allowFail = false): string {
  const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return (res.stdout ?? '').trim();
}

function banner(text: string): void {
  console.log(`\n\x1b[1m\x1b[36m━━━ ${text} ━━━\x1b[0m`);
}

function loadIssue(argv: string[]): { id?: number; title: string; body: string } {
  const fileIdx = argv.indexOf('--issue-file');
  if (fileIdx !== -1) {
    const p = path.resolve(PIPELINE_DIR, argv[fileIdx + 1]);
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n');
    const title = (lines.find((l) => l.startsWith('# ')) ?? lines[0])
      .replace(/^#\s*/, '')
      .trim();
    const body = lines
      .slice(lines.findIndex((l) => l.startsWith('# ')) + 1)
      .join('\n')
      .trim();
    return { title, body };
  }
  const idIdx = argv.indexOf('--issue');
  if (idIdx !== -1) {
    const id = Number(argv[idIdx + 1]);
    const res = spawnSync(
      'gh',
      ['issue', 'view', String(id), '--json', 'title,body'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }
    );
    if (res.status !== 0) throw new Error(`gh issue view failed: ${res.stderr}`);
    const j = JSON.parse(res.stdout);
    return { id, title: j.title, body: j.body };
  }
  throw new Error('Provide --issue-file <path> or --issue <number>');
}

interface StageOpts<T> {
  stage: string;
  buildPrompt: (attempt: number, lastError: string | null) => string;
  schema: Parameters<typeof runAgent>[0]['schema'];
  allowedTools: string[];
  permissionMode?: string;
  /** Gates run against the agent output; ALL must pass. */
  runGates: (output: T) => gates.GateResult[];
}

/** Generic stage runner: invoke agent -> run gates -> retry with gate feedback -> escalate. */
function runStage<T>(state: RunState, opts: StageOpts<T>): T {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    banner(`stage=${opts.stage} attempt=${attempt}/${MAX_ATTEMPTS}`);
    let result;
    try {
      result = runAgent({
        stage: opts.stage,
        prompt: opts.buildPrompt(attempt, lastError),
        systemPromptFile: path.join(PIPELINE_DIR, 'agents', `${opts.stage}.md`),
        schema: opts.schema,
        allowedTools: opts.allowedTools,
        model: MODELS[opts.stage],
        permissionMode: opts.permissionMode,
      });
    } catch (e) {
      // Schema failures and CLI errors are retriable like any gate failure.
      lastError = e instanceof AgentError ? e.message : String(e);
      appendTrace({
        ts: new Date().toISOString(),
        runId: state.runId,
        stage: opts.stage,
        attempt,
        event: 'gate',
        gate: 'schema',
        ok: false,
        detail: lastError.slice(0, 2000),
      });
      console.error(`  ✗ schema/agent error: ${lastError.slice(0, 300)}`);
      continue;
    }

    const rawPath = saveRaw(state.runId, opts.stage, attempt, result.rawJson);
    appendTrace({
      ts: new Date().toISOString(),
      runId: state.runId,
      stage: opts.stage,
      attempt,
      event: 'agent_result',
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      sessionId: result.sessionId,
      detail: `raw: ${path.relative(REPO_ROOT, rawPath)}`,
    });
    console.log(
      `  agent returned (cost $${result.costUsd.toFixed(4)}, ${(result.durationMs / 1000).toFixed(0)}s)`
    );

    const gateResults = opts.runGates(result.output as T);
    let allOk = true;
    for (const [i, g] of gateResults.entries()) {
      appendTrace({
        ts: new Date().toISOString(),
        runId: state.runId,
        stage: opts.stage,
        attempt,
        event: 'gate',
        gate: `${opts.stage}-gate-${i}`,
        ok: g.ok,
        detail: g.detail.slice(0, 2000),
      });
      console.log(
        `  gate ${i}: ${g.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${g.detail.trim().split('\n')[0].slice(0, 120)}`
      );
      if (!g.ok) {
        lastError = g.detail;
        allOk = false;
        break;
      }
    }
    if (allOk) {
      appendTrace({
        ts: new Date().toISOString(),
        runId: state.runId,
        stage: opts.stage,
        attempt,
        event: 'stage_done',
      });
      return result.output as T;
    }
  }
  // ---- Escalation: attempts exhausted, hand to human -------------------
  escalate(
    state,
    opts.stage,
    `stage=${opts.stage} exhausted ${MAX_ATTEMPTS} attempts. Last gate failure:\n${lastError}`
  );
}

/** Hand the run to a human: persist everything, print takeover instructions, stop. */
function escalate(state: RunState, stage: string, reason: string): never {
  state.status = 'escalated';
  state.escalation = reason;
  saveState(state);
  appendTrace({
    ts: new Date().toISOString(),
    runId: state.runId,
    stage,
    attempt: MAX_ATTEMPTS,
    event: 'escalated',
    detail: reason.slice(0, 2000),
  });
  banner(`ESCALATED at stage=${stage}`);
  console.error(reason);
  console.error(
    `\nHuman takeover:\n  state:   pipeline/traces/${state.runId}/state.json`
  );
  console.error(`  traces:  pipeline/traces/${state.runId}.jsonl`);
  console.error(`  inspect: git diff ${state.baseBranch}...${state.branch}`);
  console.error(
    `  rollback: git checkout ${state.baseBranch} && git branch -D ${state.branch}`
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const skipPr = argv.includes('--skip-pr');
  const issue = loadIssue(argv);

  const baseBranch = git(['branch', '--show-current']) || 'develop';
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const branch = `agent/${runId}`;
  git(['checkout', '-b', branch]);

  const state: RunState = {
    runId,
    branch,
    baseBranch,
    status: 'running',
    issue,
    triage: undefined,
    repro: undefined,
    fix: undefined,
    critic: undefined,
    pr: undefined,
  };
  saveState(state);
  banner(`run=${runId} branch=${branch} base=${baseBranch}`);
  console.log(`issue: ${issue.title}`);

  // ---- Stage 1: TRIAGE (read-only) --------
  // Sees: the bug report. Nothing else exists yet.
  const triage = runStage<TriageOutput>(state, {
    stage: 'triage',
    schema: TriageOutput,
    allowedTools: ['Read', 'Grep', 'Glob'],
    buildPrompt: (_, err) =>
      `Bug report:\n\nTitle: ${issue.title}\n\n${issue.body}\n\nLocate the defect.` +
      (err ? `\n\nYour previous attempt was rejected by a gate:\n${err}` : ''),
    runGates: (out) => [gates.gateFilesExist(out.files)],
  });
  state.triage = triage;
  saveState(state);

  // ---- Stage 2: REPRO ------------
  // Sees: bug report + triage. The gate demands a RED test — the pipeline's
  // definition of "the bug is real".
  const repro = runStage<ReproOutput>(state, {
    stage: 'repro',
    schema: ReproOutput,
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Write(packages/altair-app/src/**)',
      'Bash(pnpm exec jest*)',
      'Bash(cd*)',
    ],
    permissionMode: 'acceptEdits',
    buildPrompt: (_, err) =>
      `Bug report:\n\nTitle: ${issue.title}\n\n${issue.body}\n\n` +
      `Triage hypothesis (verify, don't trust blindly):\n${triage.hypothesis}\nSuspect files: ${triage.files.join(', ')}\n\n` +
      `Write ONE new failing test that reproduces this bug.` +
      (err ? `\n\nYour previous attempt was rejected by a gate:\n${err}` : ''),
    runGates: (out) => [
      // coupling first (cheap), redness second (runs jest)
      gates.gateReproTestsRealCode(out.testFilePath, triage.files),
      gates.gateMustFail(out.testFilePath),
    ],
  });
  const mustFailDetail = gates.gateMustFail(repro.testFilePath); // capture red output for state/PR
  state.repro = { ...repro, failingOutput: mustFailDetail.detail.slice(-2000) };
  saveState(state);
  git(['add', repro.testFilePath]);
  git(['commit', '-m', `test: failing repro for "${issue.title}" [agent:repro]`]);

  // ---- Stages 3+4: FIX -> CRITIC review cycle -----------------------------
  //
  // Changed after run-2: a critic rejection used to re-run the
  // CRITIC with its own rejection fed back as "gate feedback" — pressuring
  // the reviewer to change its mind while the code stayed frozen. Backwards.
  // Now a rejection routes the critic's reasons to the FIX agent (who can
  // act on them) for a bounded number of review cycles; a standing rejection
  // still escalates to a human. The critic is never asked to reconsider.
  const MAX_REVIEW_CYCLES = 2;
  let fix!: FixOutput;
  let critic!: CriticOutput;
  let criticFeedback: string | null = null;

  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle++) {
    // FIX (context-isolated): sees hypothesis + failing test — deliberately
    // NOT the raw issue thread; the failing test IS the spec. Prompt orders a
    // re-read before every edit (stale-context defense: repro just added a
    // file, and retries/cycles mutate state).
    fix = runStage<FixOutput>(state, {
      stage: 'fix',
      schema: FixOutput,
      allowedTools: [
        'Read',
        'Grep',
        'Glob',
        'Edit(packages/**)',
        'Write(packages/**)',
        'Bash(pnpm exec jest*)',
        'Bash(cd*)',
      ],
      permissionMode: 'acceptEdits',
      buildPrompt: (_, err) =>
        `A bug was localized here:\n${triage.hypothesis}\nSuspect files: ${triage.files.join(', ')}\n\n` +
        `This test reproduces it and currently FAILS: ${repro.testFilePath}\n` +
        `Failing output:\n${state.repro!.failingOutput}\n\n` +
        `Make this test pass without modifying it and without breaking anything else.` +
        (criticFeedback
          ? `\n\nAn independent reviewer REJECTED your previous fix (already applied to the code you see). ` +
            `Address every point — prefer simplifying or reworking over patching on top:\n${criticFeedback}`
          : '') +
        (err ? `\n\nYour previous attempt was rejected by a gate:\n${err}` : ''),
      runGates: () => [
        gates.gateNoTestEdits(baseBranch, repro.testFilePath),
        gates.gateDiffNotEmpty(baseBranch),
        gates.gateReproGreen(repro.testFilePath),
        gates.gateFullGreen(),
      ],
    });
    state.fix = { ...fix, attempts: cycle };
    saveState(state);
    git(['add', '--', 'packages', 'libs', 'plugins']);
    git([
      'commit',
      '-m',
      `fix: ${issue.title} [agent:fix]${cycle > 1 ? ` (review cycle ${cycle})` : ''}`,
    ]);

    // CRITIC (read-only, fresh eyes): sees the diff + minimal context. Did
    // not write the code, cannot edit it, and is never retried over a
    // standing rejection — only mechanical failures (schema, bad citations)
    // are retriable for the critic.
    const diff = git(['diff', baseBranch, '--', 'packages', 'libs', 'plugins']);
    critic = runStage<CriticOutput>(state, {
      stage: 'critic',
      schema: CriticOutput,
      allowedTools: ['Read', 'Grep', 'Glob'],
      buildPrompt: (_, err) =>
        `Reported bug: ${issue.title}\nRepro test (already verified red->green): ${repro.testFilePath}\n\n` +
        `Review this diff:\n\n${diff.slice(0, 30000)}` +
        (err ? `\n\nYour previous attempt was rejected by a gate:\n${err}` : ''),
      runGates: (out) => [gates.gateCitations(out, baseBranch)],
    });
    state.critic = critic;
    saveState(state);

    if (critic.verdict === 'approve') break;

    criticFeedback =
      critic.reasons +
      '\n' +
      critic.claims.map((c) => `- ${c.text} (${c.cite})`).join('\n');
    appendTrace({
      ts: new Date().toISOString(),
      runId: state.runId,
      stage: 'critic',
      attempt: cycle,
      event: 'info',
      detail: `rejected fix in review cycle ${cycle}; routing feedback to the fix agent`,
    });
    console.log(
      `  critic \x1b[31mREJECTED\x1b[0m the fix (review cycle ${cycle}/${MAX_REVIEW_CYCLES}) — routing feedback to the fix agent`
    );
    if (cycle === MAX_REVIEW_CYCLES) {
      escalate(
        state,
        'critic',
        `fix still rejected after ${MAX_REVIEW_CYCLES} review cycles — the pipeline never merges over a standing rejection.\nLast review:\n${criticFeedback}`
      );
    }
  }

  // ---- Stage 5: PR (composition only, no repo access needed) -------------
  const pr = runStage<PrOutput>(state, {
    stage: 'pr',
    schema: PrOutput,
    allowedTools: ['Read'],
    buildPrompt: (_, err) =>
      `Compose the pull request.\n\nIssue: ${issue.title}${issue.id ? ` (#${issue.id})` : ''}\n${issue.body}\n\n` +
      `Root cause: ${triage.hypothesis}\n\nFix summary: ${fix.diffSummary}\nChanged files: ${fix.changedFiles.join(', ')}\n` +
      `Repro test: ${repro.testFilePath} (was red on ${baseBranch}, green after fix; full suite green)\n` +
      `Critic verdict: ${critic.verdict} — ${critic.reasons}\nRisk notes: ${fix.riskNotes}` +
      (err ? `\n\nPrevious attempt rejected:\n${err}` : ''),
    runGates: () => [],
  });
  state.pr = pr;

  if (!skipPr) {
    banner('push + open PR (human merges — the pipeline never merges)');
    const bodyFile = path.join(PIPELINE_DIR, 'traces', state.runId, 'pr-body.md');
    fs.writeFileSync(bodyFile, pr.body);
    git(['push', '-u', 'origin', branch], true);
    const res = spawnSync(
      'gh',
      [
        'pr',
        'create',
        '--base',
        baseBranch,
        '--head',
        branch,
        '--title',
        pr.title,
        '--body-file',
        bodyFile,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }
    );
    if (res.status === 0) {
      state.pr.url = res.stdout.trim();
      console.log(`PR opened: ${state.pr.url}`);
    } else {
      console.log(
        `Could not open PR automatically (${(res.stderr ?? '').slice(0, 200)}).`
      );
      console.log(
        `Open manually: gh pr create --base ${baseBranch} --head ${branch} --title "${pr.title}" --body-file ${bodyFile}`
      );
    }
  }

  state.status = 'done';
  saveState(state);

  banner('run summary (from traces)');
  console.table(summarize(runId));
  console.log(`state:  pipeline/traces/${runId}/state.json`);
  console.log(`traces: pipeline/traces/${runId}.jsonl`);
  console.log(
    `\nHUMAN-IN-THE-LOOP: review and merge the PR yourself. The pipeline stops here.`
  );
}

main();
