import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CriticOutput } from './state.js';
import { REPO_ROOT } from './trace.js';

export interface GateResult {
  ok: boolean;
  detail: string;
}

const APP_DIR = path.join(REPO_ROOT, 'packages', 'altair-app');

function jest(testPathOrPattern: string | undefined): { status: number; output: string } {
  const args = ['exec', 'jest'];
  if (testPathOrPattern) {
    // jest inside packages/altair-app wants paths relative to that package
    args.push(testPathOrPattern.replace(/^packages\/altair-app\//, ''));
  }
  args.push('--coverage=false', '--silent');
  const res = spawnSync('pnpm', args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return {
    status: res.status ?? 1,
    output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  };
}

/** GATE: every file the triage agent named must actually exist. */
export function gateFilesExist(files: string[]): GateResult {
  const missing = files.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
  return missing.length === 0
    ? { ok: true, detail: `all ${files.length} files exist` }
    : {
        ok: false,
        detail: `these files do not exist in the repo: ${missing.join(', ')}. Only name files you have actually opened.`,
      };
}

/** GATE: the repro test must exercise the REAL code under test. */
export function gateReproTestsRealCode(testFilePath: string, suspectFiles: string[]): GateResult {
  const abs = path.join(REPO_ROOT, testFilePath);
  if (!fs.existsSync(abs)) {
    return { ok: false, detail: `test file ${testFilePath} does not exist on disk` };
  }
  const src = fs.readFileSync(abs, 'utf8');
  const relImports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((s) => s.startsWith('.'));
  const testDir = path.dirname(abs);
  const resolved: string[] = [];
  for (const imp of relImports) {
    for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
      const p = path.resolve(testDir, imp + suffix);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        resolved.push(path.relative(REPO_ROOT, p));
        break;
      }
    }
  }
  const sourceImports = resolved.filter((f) => !/\.spec\.ts$/.test(f));
  if (sourceImports.length === 0) {
    return {
      ok: false,
      detail:
        `the repro test imports NO source file from this repository. A test that re-implements or ` +
        `simulates the suspected bug inside itself proves nothing about the real code. Import and ` +
        `exercise the actual module under test (e.g. one of: ${suspectFiles.join(', ')}).`,
    };
  }
  const suspectBases = suspectFiles.map((f) => path.basename(f).replace(/\.tsx?$/, ''));
  const touchesSuspect = sourceImports.some((f) =>
    suspectBases.includes(path.basename(f).replace(/\.tsx?$/, ''))
  );
  return touchesSuspect
    ? { ok: true, detail: `repro imports real source under test: ${sourceImports.join(', ')}` }
    : {
        ok: false,
        detail:
          `the repro test imports ${sourceImports.join(', ')} but none of the triage suspect files ` +
          `(${suspectFiles.join(', ')}). Test the code the bug actually lives in.`,
      };
}

/** GATE: the repro test MUST FAIL on the current (buggy) code. */
export function gateMustFail(testFilePath: string): GateResult {
  if (!fs.existsSync(path.join(REPO_ROOT, testFilePath))) {
    return { ok: false, detail: `test file ${testFilePath} does not exist on disk` };
  }
  const { status, output } = jest(testFilePath);
  const tail = output.slice(-3000);
  if (status === 0) {
    return {
      ok: false,
      detail: `GATE FAILED: the repro test PASSED on the buggy code. A repro test must fail because of the bug. Jest output:\n${tail}`,
    };
  }
  if (/No tests found/i.test(output)) {
    return {
      ok: false,
      detail: `jest found no tests in ${testFilePath} — wrong path or wrong file naming?\n${tail}`,
    };
  }
  if (/Cannot find module|SyntaxError|Test suite failed to run/i.test(output)) {
    return {
      ok: false,
      detail: `the test fails due to a setup/compile error, not the bug. Fix the test so it fails on an ASSERTION.\n${tail}`,
    };
  }
  return { ok: true, detail: tail };
}

/** GATE: after the fix, the repro test must be green. */
export function gateReproGreen(testFilePath: string): GateResult {
  const { status, output } = jest(testFilePath);
  return status === 0
    ? { ok: true, detail: 'repro test passes after fix' }
    : {
        ok: false,
        detail: `repro test still fails after your fix:\n${output.slice(-3000)}`,
      };
}

/** GATE: the full altair-app suite must be green (no collateral damage). */
export function gateFullGreen(): GateResult {
  const { status, output } = jest(undefined);
  return status === 0
    ? { ok: true, detail: 'full altair-app jest suite green' }
    : {
        ok: false,
        detail: `full suite has failures — your fix broke something:\n${output.slice(-4000)}`,
      };
}

/** GATE: the fix agent must not touch any test file or test/jest config. */
export function gateNoTestEdits(baseBranch: string, reproFile: string): GateResult {
  const res = spawnSync('git', ['diff', '--name-only', baseBranch, '--'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const changed = (res.stdout ?? '').split('\n').filter(Boolean);
  const illegal = changed.filter(
    (f) =>
      f !== reproFile &&
      (/\.spec\.ts$/.test(f) || /jest\.config/.test(f) || /tsconfig.*\.json$/.test(f) || f.startsWith('pipeline/'))
  );
  return illegal.length === 0
    ? { ok: true, detail: 'no test/config files modified' }
    : {
        ok: false,
        detail: `you modified files you must not touch: ${illegal.join(', ')}. Revert them and fix the source instead.`,
      };
}

/** GATE: the diff must not be empty. */
export function gateDiffNotEmpty(baseBranch: string): GateResult {
  const res = spawnSync('git', ['diff', '--stat', baseBranch, '--', 'packages', 'libs', 'plugins'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return (res.stdout ?? '').trim().length > 0
    ? { ok: true, detail: res.stdout.trim().split('\n').slice(-1)[0] }
    : {
        ok: false,
        detail:
          'the diff against the base branch is empty — no fix was actually applied',
      };
}

/** GATE: every critic claim must cite a file:line that exists and is part of
 * the diff. */
export function gateCitations(critic: CriticOutput, baseBranch: string): GateResult {
  const res = spawnSync('git', ['diff', '--name-only', baseBranch, '--'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const diffFiles = new Set((res.stdout ?? '').split('\n').filter(Boolean));
  const problems: string[] = [];
  for (const claim of critic.claims) {
    const [file, lineStr] = claim.cite.split(':');
    const line = Number(lineStr);
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) {
      problems.push(`${claim.cite}: file does not exist`);
      continue;
    }
    if (!diffFiles.has(file)) {
      problems.push(`${claim.cite}: file is not part of the diff under review`);
      continue;
    }
    const lineCount = fs.readFileSync(abs, 'utf8').split('\n').length;
    if (!Number.isFinite(line) || line < 1 || line > lineCount) {
      problems.push(`${claim.cite}: line out of range (file has ${lineCount} lines)`);
    }
  }
  return problems.length === 0
    ? { ok: true, detail: `all ${critic.claims.length} citations verified` }
    : {
        ok: false,
        detail: `unverifiable citations:\n${problems.join('\n')}\nEvery claim must cite an existing file:line inside the diff.`,
      };
}
