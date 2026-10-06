import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FIXTURES_PATH = fileURLToPath(new URL('../assets/benchmark/tasks.json', import.meta.url));

function stableHash(value) {
  const normalized = JSON.stringify(value, Object.keys(value ?? {}).sort());
  return createHash('sha256').update(normalized).digest('hex');
}

export async function loadBenchmarkFixtures(path = DEFAULT_FIXTURES_PATH) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.fixtures)) throw new Error('Unsupported benchmark fixture manifest');
  const ids = new Set();
  for (const fixture of parsed.fixtures) {
    if (!fixture.id || ids.has(fixture.id)) throw new Error(`Invalid or duplicate benchmark fixture id: ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.verifier?.type !== 'exact-files') throw new Error(`Unsupported verifier for ${fixture.id}`);
  }
  return parsed.fixtures;
}

export function validateLiveBudgets(budgets = {}) {
  for (const field of ['maxTasks', 'maxAttempts', 'maxTokens', 'timeoutMs']) {
    if (!Number.isFinite(budgets[field]) || budgets[field] <= 0) throw new Error(`Live benchmark budget ${field} is required`);
  }
  if (budgets.maxDollars !== undefined && (!Number.isFinite(budgets.maxDollars) || budgets.maxDollars <= 0)) {
    throw new Error('Live benchmark maxDollars must be positive');
  }
  return {
    maxTasks: Math.floor(budgets.maxTasks), maxAttempts: Math.floor(budgets.maxAttempts),
    maxTokens: Math.floor(budgets.maxTokens), timeoutMs: Math.floor(budgets.timeoutMs),
    maxDollars: budgets.maxDollars ?? null,
  };
}

function normalizeEventUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = value.usage ?? value.token_usage ?? value.tokenUsage;
  if (usage && typeof usage === 'object') {
    return {
      inputTokens: usage.inputTokens ?? usage.input_tokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? usage.cached_input_tokens ?? null,
      outputTokens: usage.outputTokens ?? usage.output_tokens ?? null,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? null,
      totalTokens: usage.totalTokens ?? usage.total_tokens ?? null,
    };
  }
  for (const item of Object.values(value)) {
    const nested = normalizeEventUsage(item);
    if (nested) return nested;
  }
  return null;
}

export function createNativeBenchmarkProvider({ codexPath = 'codex', combinations, spawnImpl = spawn } = {}) {
  if (!combinations || typeof combinations !== 'object') throw new Error('Live benchmark strategy combinations are required');
  return {
    destination: 'codex-subscription',
    canMeasureCost: false,
    async execute({ task, strategy, workspace, budgets, signal }) {
      const combination = combinations[strategy];
      if (!combination?.model || !combination?.effort) throw new Error(`No live model/effort configured for strategy ${strategy}`);
      const prompt = [
        task.prompt,
        task.history?.length ? `Prior task history:\n${task.history.join('\n')}` : '',
        'Work only in the provided temporary benchmark directory. Do not install dependencies, deploy, or use network access.',
      ].filter(Boolean).join('\n\n');
      const args = [
        'exec', '-C', workspace, '--skip-git-repo-check', '--ephemeral',
        '--ignore-user-config',
        '-m', combination.model,
        '-c', `model_reasoning_effort=${JSON.stringify(combination.effort)}`,
        '-c', 'approval_policy="never"',
        '-s', 'workspace-write', '--json', '-',
      ];
      return new Promise((resolve, reject) => {
        const child = spawnImpl(codexPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          callback(value);
        };
        const abort = () => {
          if (!child.killed) child.kill('SIGTERM');
          finish(reject, new Error(`Live benchmark attempt timed out or was cancelled; cancellation may be delayed by the provider`));
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', (error) => finish(reject, error));
        child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4_000_000); });
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000); });
        child.once('exit', (code, exitSignal) => {
          if (code !== 0) {
            finish(reject, new Error(`Codex benchmark attempt failed (${exitSignal ?? code}): ${stderr.trim().slice(-1000)}`));
            return;
          }
          let usage = null;
          for (const line of stdout.split('\n').filter(Boolean)) {
            try { usage = normalizeEventUsage(JSON.parse(line)) ?? usage; } catch { /* Non-JSON output is not usage evidence. */ }
          }
          if (Number.isFinite(usage?.totalTokens) && usage.totalTokens > budgets.maxTokens) {
            finish(reject, new Error('Live attempt exceeded the maxTokens checkpoint budget'));
            return;
          }
          finish(resolve, { usage });
        });
        child.stdin.end(prompt);
      });
    },
  };
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files ?? {})) {
    const path = safeWorkspacePath(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(content), 'utf8');
  }
}

function safeWorkspacePath(root, relative) {
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, relative);
  if (path !== absoluteRoot && !path.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Fixture path escapes benchmark workspace: ${relative}`);
  }
  return path;
}

async function verifyFiles(root, expected) {
  const mismatches = [];
  for (const [relative, content] of Object.entries(expected ?? {})) {
    try {
      const path = safeWorkspacePath(root, relative);
      if ((await lstat(path)).isSymbolicLink() || await readFile(path, 'utf8') !== content) mismatches.push(relative);
    } catch {
      mismatches.push(relative);
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}

const defaultMockProvider = {
  async execute({ task }) {
    if (task.expectedFailureType === 'environment') {
      return { files: task.initialFiles, failureType: 'environment', usage: null };
    }
    return { files: task.expectedFiles, usage: null };
  },
};

function deterministicOrder(items, seed) {
  return [...items].sort((a, b) => stableHash(`${seed}:${a.task.id}:${a.strategy}`).localeCompare(stableHash(`${seed}:${b.task.id}:${b.strategy}`)));
}

export async function runBenchmark({
  fixtures,
  strategies = ['baseline', 'economy', 'tier-baseline', 'joint'],
  mode = 'mock',
  budgets,
  provider,
  repair = false,
  seed = 'codex-smart-benchmark-v1',
  keepWorkspaces = false,
} = {}) {
  if (!['mock', 'live'].includes(mode)) throw new Error(`Unsupported benchmark mode: ${mode}`);
  const limits = mode === 'live' ? validateLiveBudgets(budgets) : null;
  const availableTasks = fixtures ?? await loadBenchmarkFixtures();
  const tasks = mode === 'live' ? availableTasks.slice(0, limits.maxTasks) : availableTasks;
  if (mode === 'live' && !provider) throw new Error('Live benchmark requires an explicitly configured execution provider');
  if (mode === 'live' && limits.maxDollars !== null && !provider.canMeasureCost) {
    throw new Error('Cannot guarantee maxDollars without a reliable price catalog for the live provider');
  }
  const executor = provider ?? defaultMockProvider;
  const pairs = deterministicOrder(tasks.flatMap((task) => strategies.map((strategy) => ({ task, strategy }))), seed);
  const results = [];
  let attemptsUsed = 0;
  let tokensUsed = 0;
  for (const { task, strategy } of pairs) {
    const workspace = await mkdtemp(join(tmpdir(), `codex-smart-benchmark-${task.id}-`));
    const verifierHash = stableHash(task.verifier);
    const initialStateHash = stableHash(task.initialFiles);
    await writeFiles(workspace, task.initialFiles);
    const attempts = [];
    let validation = { passed: false, mismatches: [] };
    let failureType = null;
    const maximumAttempts = repair ? 2 : 1;
    try {
      for (let number = 0; number < maximumAttempts; number += 1) {
        if (mode === 'live' && attemptsUsed >= limits.maxAttempts) throw new Error('Live maxAttempts budget exhausted');
        const attemptId = randomUUID();
        const started = Date.now();
        const controller = new AbortController();
        const timeoutMs = mode === 'live' ? Math.min(limits.timeoutMs, task.resources?.timeoutMs ?? limits.timeoutMs) : null;
        const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
        let output;
        try {
          const attemptBudgets = limits ? {
            ...limits,
            maxTokens: Math.min(limits.maxTokens, task.resources?.maxTokens ?? limits.maxTokens),
            timeoutMs,
          } : null;
          output = await executor.execute({
            task, strategy, workspace, attempt: number + 1, budgets: attemptBudgets,
            signal: controller.signal,
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
        attemptsUsed += 1;
        const attemptTokens = output.usage?.totalTokens ?? 0;
        tokensUsed += attemptTokens;
        if (mode === 'live' && tokensUsed > limits.maxTokens) throw new Error('Live maxTokens budget exhausted');
        await writeFiles(workspace, output.files);
        failureType = output.failureType ?? null;
        validation = failureType ? { passed: false, mismatches: [] } : await verifyFiles(workspace, task.expectedFiles);
        attempts.push({
          attemptId, retryOf: attempts.at(-1)?.attemptId ?? null,
          validationStatus: validation.passed ? 'passed' : 'failed', failureType: failureType ?? (validation.passed ? null : 'logic'),
          durationMs: Date.now() - started, usage: output.usage ?? null,
        });
        if (validation.passed || failureType !== null) break;
      }
      results.push({
        taskId: task.id, strategy, workspace, initialStateHash,
        synthetic: mode === 'mock', validationStatus: validation.passed ? 'passed' : 'failed',
        failureType: failureType ?? (validation.passed ? null : 'logic'), attempts,
        verifierIntegrity: { ok: verifierHash === stableHash(task.verifier), expectedHash: verifierHash },
      });
    } finally {
      if (!keepWorkspaces) await rm(workspace, { recursive: true, force: true });
    }
  }
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    mode,
    measurement: mode === 'mock' ? 'synthetic' : 'observed',
    warning: mode === 'mock' ? 'Synthetic pipeline validation only; no model quality or savings were measured.' : null,
    budgetNote: mode === 'live' ? 'Budgets are checked before requests and at provider event checkpoints; cancellation can be delayed.' : null,
    seed,
    strategies,
    budgets: limits,
    usage: { attempts: attemptsUsed, totalTokens: mode === 'live' ? tokensUsed : null },
    results,
  };
}

export function summarizeBenchmark(report) {
  const groups = {};
  for (const strategy of report.strategies) {
    const rows = report.results.filter((result) => result.strategy === strategy);
    groups[strategy] = {
      tasks: rows.length,
      passed: rows.filter((result) => result.validationStatus === 'passed').length,
      failed: rows.filter((result) => result.validationStatus === 'failed').length,
      retries: rows.reduce((sum, result) => sum + Math.max(0, result.attempts.length - 1), 0),
      successRate: report.mode === 'live' && rows.length ? rows.filter((result) => result.validationStatus === 'passed').length / rows.length : null,
    };
  }
  return { schemaVersion: 1, runId: report.runId, measurement: report.measurement, strategies: groups };
}
