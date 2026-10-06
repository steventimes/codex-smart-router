import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createNativeBenchmarkProvider, loadBenchmarkFixtures, runBenchmark, validateLiveBudgets } from '../src/benchmark.mjs';

test('ships at least twelve original fixtures including multi-turn and constraint cases', async () => {
  const fixtures = await loadBenchmarkFixtures();
  assert.ok(fixtures.length >= 12);
  assert.ok(fixtures.filter((fixture) => fixture.history?.length).length >= 2);
  assert.ok(fixtures.some((fixture) => fixture.constraints?.includes('image')));
  assert.ok(fixtures.some((fixture) => fixture.expectedFailureType === 'environment'));
  for (const fixture of fixtures) {
    assert.ok(fixture.initialFiles && fixture.expectedFiles);
    assert.ok(fixture.verifier?.type);
    assert.ok(fixture.resources?.timeoutMs > 0);
  }
});

test('mock replay isolates each strategy, protects verifiers, and labels every result synthetic', async () => {
  const fixtures = (await loadBenchmarkFixtures()).slice(0, 2);
  const report = await runBenchmark({ fixtures, strategies: ['baseline', 'joint'], mode: 'mock' });
  assert.equal(report.measurement, 'synthetic');
  assert.equal(report.results.length, 4);
  assert.equal(new Set(report.results.map((result) => result.workspace)).size, 4);
  assert.equal(report.results.every((result) => result.synthetic), true);
  assert.equal(report.results.every((result) => result.verifierIntegrity.ok), true);
  for (const fixture of fixtures) {
    const initialHashes = report.results.filter((result) => result.taskId === fixture.id).map((result) => result.initialStateHash);
    assert.equal(new Set(initialHashes).size, 1);
  }
});

test('live replay requires hard task, attempt, token, and timeout budgets', () => {
  assert.throws(() => validateLiveBudgets({ maxTasks: 1 }), /maxAttempts/);
  assert.deepEqual(validateLiveBudgets({ maxTasks: 1, maxAttempts: 2, maxTokens: 1000, timeoutMs: 5000 }), {
    maxTasks: 1, maxAttempts: 2, maxTokens: 1000, timeoutMs: 5000, maxDollars: null,
  });
});

test('bounded repair creates at most one linked second attempt', async () => {
  const fixture = (await loadBenchmarkFixtures())[0];
  let calls = 0;
  const provider = { async execute({ task }) {
    calls += 1;
    return calls === 1 ? { files: task.initialFiles, usage: null } : { files: task.expectedFiles, usage: null };
  } };
  const report = await runBenchmark({ fixtures: [fixture], strategies: ['joint'], mode: 'mock', provider, repair: true });
  assert.equal(report.results[0].attempts.length, 2);
  assert.equal(report.results[0].attempts[1].retryOf, report.results[0].attempts[0].attemptId);
  assert.equal(report.results[0].validationStatus, 'passed');
});

test('rejects fixture paths that escape the isolated workspace', async () => {
  const fixture = {
    id: 'escape', prompt: 'bad fixture', taskType: 'security',
    initialFiles: { '../escape.txt': 'no' }, expectedFiles: {},
    verifier: { type: 'exact-files' }, resources: { timeoutMs: 1000, maxTokens: 100 },
  };
  await assert.rejects(() => runBenchmark({ fixtures: [fixture], strategies: ['baseline'], mode: 'mock' }), /escapes benchmark workspace/i);
});

test('native live provider uses current bounded Codex exec flags and reports usage evidence', async () => {
  let invocation;
  const spawnImpl = (command, args) => {
    invocation = { command, args };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { total_tokens: 20 } })}\n`);
      child.emit('exit', 0, null);
    });
    return child;
  };
  const provider = createNativeBenchmarkProvider({
    codexPath: 'codex-test', spawnImpl,
    combinations: { joint: { model: 'model-a', effort: 'high' } },
  });
  const result = await provider.execute({
    task: { prompt: 'Make the edit', history: [] }, strategy: 'joint', workspace: '/tmp/work',
    budgets: { maxTokens: 100 }, signal: new AbortController().signal,
  });
  assert.equal(invocation.command, 'codex-test');
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.equal(invocation.args.includes('-a'), false);
  assert.equal(result.usage.totalTokens, 20);
});
