import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunState } from './state.js';

const PIPELINE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TRACES_DIR = path.join(PIPELINE_DIR, 'traces');
export const REPO_ROOT = path.resolve(PIPELINE_DIR, '..');

export interface TraceEntry {
  ts: string;
  runId: string;
  stage: string;
  attempt: number;
  event: 'agent_result' | 'gate' | 'stage_done' | 'escalated' | 'info';
  durationMs?: number;
  costUsd?: number;
  sessionId?: string;
  gate?: string;
  ok?: boolean;
  detail?: string;
}

function ensureDirs(runId: string): void {
  fs.mkdirSync(path.join(TRACES_DIR, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(TRACES_DIR, runId), { recursive: true });
}

export function appendTrace(entry: TraceEntry): void {
  ensureDirs(entry.runId);
  const file = path.join(TRACES_DIR, `${entry.runId}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

/** Dump the full raw JSON response of an agent call (the actual trace to show). */
const rawSeq = new Map<string, number>();
export function saveRaw(
  runId: string,
  stage: string,
  attempt: number,
  rawJson: string
): string {
  ensureDirs(runId);
  const seq = (rawSeq.get(runId) ?? 0) + 1;
  rawSeq.set(runId, seq);
  const file = path.join(
    TRACES_DIR,
    'raw',
    `${runId}-call${String(seq).padStart(2, '0')}-${stage}-attempt${attempt}.json`
  );
  fs.writeFileSync(file, rawJson);
  return file;
}

export function saveState(state: RunState): string {
  ensureDirs(state.runId);
  const file = path.join(TRACES_DIR, state.runId, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

/** Per-stage cost/latency/invocation summary printed at the end of a run.
 *
 * Fixed after run-3: the old `attempts` column took the max of
 * the per-invocation retry counter, which resets to 1 each review cycle — a
 * fix agent invoked twice (cycle 1 + cycle 2) showed as `attempts: 1`.
 * Telemetry that undercounts work is worse than none: `invocations` now
 * counts actual agent calls (retries AND review cycles), and `retries`
 * counts within-invocation retry attempts beyond the first. */
export function summarize(runId: string): Array<Record<string, string | number>> {
  const file = path.join(TRACES_DIR, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const entries: TraceEntry[] = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const byStage = new Map<
    string,
    {
      costUsd: number;
      ms: number;
      invocations: number;
      retries: number;
      gatesFailed: number;
    }
  >();
  for (const e of entries) {
    const s =
      byStage.get(e.stage) ??
      { costUsd: 0, ms: 0, invocations: 0, retries: 0, gatesFailed: 0 };
    if (e.event === 'agent_result') {
      s.costUsd += e.costUsd ?? 0;
      s.ms += e.durationMs ?? 0;
      s.invocations += 1;
      if (e.attempt > 1) s.retries += 1;
    }
    if (e.event === 'gate' && e.ok === false) s.gatesFailed += 1;
    byStage.set(e.stage, s);
  }
  const rows = [...byStage.entries()].map(([stage, s]) => ({
    stage,
    invocations: s.invocations,
    retries: s.retries,
    gates_failed: s.gatesFailed,
    cost_usd: Number(s.costUsd.toFixed(4)),
    minutes: Number((s.ms / 60000).toFixed(2)),
  }));
  const total = rows.reduce(
    (t, r) => ({
      stage: 'TOTAL',
      invocations: t.invocations + (r.invocations as number),
      retries: t.retries + (r.retries as number),
      gates_failed: t.gates_failed + (r.gates_failed as number),
      cost_usd: Number((t.cost_usd + (r.cost_usd as number)).toFixed(4)),
      minutes: Number((t.minutes + (r.minutes as number)).toFixed(2)),
    }),
    {
      stage: 'TOTAL',
      invocations: 0,
      retries: 0,
      gates_failed: 0,
      cost_usd: 0,
      minutes: 0,
    }
  );
  return [...rows, total];
}
