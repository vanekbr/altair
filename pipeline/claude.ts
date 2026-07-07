/**
 * Each agent is a separate headless `claude -p` process:
 *  - hard context isolation (an agent physically cannot see another agent's transcript)
 *  - per-agent tool restrictions via --allowedTools / --disallowedTools
 *  - structured output enforced with --json-schema, then re-validated with zod
 *  - per-call cost & latency come back in the response JSON (total_cost_usd, duration_ms)
 */
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { jsonSchemaFor } from './state.js';
import { REPO_ROOT } from './trace.js';

/**
 * Anti-cheat + hermeticity, applied to every agent:
 *  - pipeline/ is invisible (prompts, traces, ground truth must not leak into agents)
 *  - git history is blocked (a bug's fix might exist in history)
 *  - no network (the bug must be diagnosed from the code in front of it)
 */
const GLOBAL_DISALLOWED = [
  'Read(./pipeline/**)',
  'Grep(./pipeline/**)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git blame*)',
  'Bash(git reflog*)',
  'WebFetch',
  'WebSearch',
];

export interface AgentCall<S extends z.ZodType> {
  stage: string;
  /** The task prompt — built ONLY from the state slices this agent may see. */
  prompt: string;
  /** Role prompt file, appended to the system prompt. */
  systemPromptFile: string;
  /** Output contract. Enforced by --json-schema and re-validated with zod. */
  schema: S;
  allowedTools: string[];
  disallowedTools?: string[];
  model?: string;
  /** 'acceptEdits' for agents that write files (repro, fix). */
  permissionMode?: string;
  timeoutMs?: number;
}

export interface AgentResult<T> {
  output: T;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  rawJson: string;
}

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly rawJson?: string
  ) {
    super(message);
  }
}

export function runAgent<S extends z.ZodType>(
  call: AgentCall<S>
): AgentResult<z.infer<S>> {
  const args = [
    '-p',
    call.prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(jsonSchemaFor(call.schema)),
    '--append-system-prompt-file',
    call.systemPromptFile,
    '--allowedTools',
    call.allowedTools.join(','),
    '--disallowedTools',
    [...GLOBAL_DISALLOWED, ...(call.disallowedTools ?? [])].join(','),
  ];
  if (call.model) args.push('--model', call.model);
  if (call.permissionMode) args.push('--permission-mode', call.permissionMode);

  const started = Date.now();
  const res = spawnSync('claude', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: call.timeoutMs ?? 20 * 60 * 1000,
  });

  if (res.error) {
    throw new AgentError(
      `[${call.stage}] failed to spawn claude: ${res.error.message}`,
      call.stage
    );
  }
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').slice(-2000);
    throw new AgentError(
      `[${call.stage}] claude exited ${res.status}: ${tail}`,
      call.stage
    );
  }

  let parsed: {
    structured_output?: unknown;
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    session_id?: string;
    is_error?: boolean;
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new AgentError(
      `[${call.stage}] could not parse claude output as JSON: ${res.stdout.slice(0, 500)}`,
      call.stage,
      res.stdout
    );
  }
  if (parsed.is_error) {
    throw new AgentError(
      `[${call.stage}] claude reported an error: ${parsed.result}`,
      call.stage,
      res.stdout
    );
  }

  // Prefer structured_output (from --json-schema); fall back to parsing result text.
  const candidate =
    parsed.structured_output !== undefined
      ? parsed.structured_output
      : looseJsonParse(parsed.result ?? '');

  // GATE (schema): zod re-validation
  const validation = call.schema.safeParse(candidate);
  if (!validation.success) {
    throw new AgentError(
      `[${call.stage}] output failed schema validation: ${validation.error.message}`,
      call.stage,
      res.stdout
    );
  }

  return {
    output: validation.data,
    costUsd: parsed.total_cost_usd ?? 0,
    durationMs: parsed.duration_ms ?? Date.now() - started,
    sessionId: parsed.session_id ?? 'unknown',
    rawJson: res.stdout,
  };
}

function looseJsonParse(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body.trim());
  } catch {
    return undefined;
  }
}
