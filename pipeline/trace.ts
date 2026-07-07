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

export function saveRaw(
  runId: string,
  stage: string,
  attempt: number,
  rawJson: string
): string {
  ensureDirs(runId);
  const file = path.join(
    TRACES_DIR,
    'raw',
    `${runId}-${stage}-attempt${attempt}.json`
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

export function summarize(runId: string): Array<Record<string, string | number>> {
  const file = path.join(TRACES_DIR, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const entries: TraceEntry[] = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const byStage = new Map<string, { costUsd: number; ms: number; attempts: number; gatesFailed: number }>();
  for (const e of entries) {
    const s = byStage.get(e.stage) ?? { costUsd: 0, ms: 0, attempts: 0, gatesFailed: 0 };
    if (e.event === 'agent_result') {
      s.costUsd += e.costUsd ?? 0;
      s.ms += e.durationMs ?? 0;
      s.attempts = Math.max(s.attempts, e.attempt);
    }
    if (e.event === 'gate' && e.ok === false) s.gatesFailed += 1;
    byStage.set(e.stage, s);
  }
  return [...byStage.entries()].map(([stage, s]) => ({
    stage,
    attempts: s.attempts,
    gates_failed: s.gatesFailed,
    cost_usd: Number(s.costUsd.toFixed(4)),
    minutes: Number((s.ms / 60000).toFixed(2)),
  }));
}
