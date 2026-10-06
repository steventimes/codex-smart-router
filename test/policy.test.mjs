import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCandidateSet, routePrompt } from '../src/router.mjs';
import { evaluatePolicy, fitPolicy, loadPolicy, selectPolicyCandidate, splitPolicyRecords } from '../src/policy.mjs';

const catalog = {
  fingerprint: 'catalog-v1',
  models: [
    { id: 'a', model: 'model-a', displayName: 'A', description: '', hidden: false, isDefault: true, inputModalities: ['text'], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'b', model: 'model-b', displayName: 'B', description: '', hidden: false, isDefault: false, inputModalities: ['text'], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ],
};

function row(id, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: `task-${id}`,
    repositoryHash: `repo-${id % 2}`,
    timestamp: `2026-0${(id % 3) + 1}-01T00:00:00.000Z`,
    taskType: 'implementation', risk: 'low', verifiability: 'strong',
    model: 'model-b', effort: 'high', validationStatus: 'passed', failureType: null,
    durationMs: 100 + id, usage: { totalTokens: 10 + id }, catalogFingerprint: 'catalog-v1',
    ...overrides,
  };
}

test('fits Wilson-smoothed statistics from only capability-valid labels', () => {
  const artifact = fitPolicy([
    row(1), row(2), row(3, { validationStatus: 'failed', failureType: 'logic' }),
    row(4, { validationStatus: 'unknown' }),
    row(5, { validationStatus: 'failed', failureType: 'environment' }),
    row(6, { validationStatus: 'not_run' }),
  ], { validationFraction: 0, minimumSamples: 3 });
  const entry = Object.values(artifact.buckets)[0].combinations['model-b\0high'];
  assert.equal(artifact.training.included, 3);
  assert.equal(artifact.training.excluded, 3);
  assert.deepEqual({ samples: entry.samples, successes: entry.successes, failures: entry.failures }, { samples: 3, successes: 2, failures: 1 });
  assert.equal(entry.smoothedRate, 0.6);
  assert.ok(entry.interval.lower < entry.smoothedRate);
  assert.ok(entry.interval.upper > entry.smoothedRate);
  assert.match(artifact.method.description, /Wilson/i);
  assert.deepEqual(artifact, fitPolicy([
    row(1), row(2), row(3, { validationStatus: 'failed', failureType: 'logic' }),
    row(4, { validationStatus: 'unknown' }),
    row(5, { validationStatus: 'failed', failureType: 'environment' }),
    row(6, { validationStatus: 'not_run' }),
  ], { validationFraction: 0, minimumSamples: 3 }));
});

test('splits deterministically without leaking task/repository/time groups', () => {
  const records = Array.from({ length: 30 }, (_, index) => row(index));
  const first = splitPolicyRecords(records, { validationFraction: 0.3, seed: 'stable' });
  const second = splitPolicyRecords(records, { validationFraction: 0.3, seed: 'stable' });
  assert.deepEqual(first, second);
  const trainGroups = new Set(first.train.map((item) => item.splitGroup));
  assert.equal(first.validation.some((item) => trainGroups.has(item.splitGroup)), false);
});

test('loads a policy and falls back for an unknown catalog or model', async () => {
  const artifact = fitPolicy([row(1), row(2), row(3)], { validationFraction: 0, minimumSamples: 3 });
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-policy-'));
  const path = join(directory, 'policy.json');
  await writeFile(path, JSON.stringify(artifact));
  const loaded = await loadPolicy(path);
  const candidates = buildCandidateSet(catalog);
  const features = { taskType: 'implementation', risk: 'low', verifiability: 'strong' };
  assert.equal(selectPolicyCandidate(loaded, features, candidates, { catalogFingerprint: 'different' }), null);
  assert.equal(selectPolicyCandidate(loaded, features, candidates.filter((item) => item.model === 'model-a'), { catalogFingerprint: 'catalog-v1' }), null);
});

test('online routing actually uses a loaded policy with enough evidence', async () => {
  const policy = fitPolicy([row(1), row(2), row(3)], { validationFraction: 0, minimumSamples: 3 });
  const candidates = buildCandidateSet(catalog);
  const classifierCandidate = candidates.find((candidate) => candidate.model === 'model-a');
  const classifier = { async classify() {
    return {
      schemaVersion: 1, candidateId: classifierCandidate.id, abstain: false, confidence: 0.9,
      taskType: 'implementation', scope: 'focused', ambiguity: 'low', risk: 'low',
      verifiability: 'strong', reasonCodes: ['semantic_match'], classifier: null,
    };
  } };
  const decision = await routePrompt('Implement the focused change', catalog, { classifier, policy });
  assert.equal(decision.execution.model, 'model-b');
  assert.equal(decision.source, 'policy');
  assert.equal(decision.statisticalEvidenceCount, 3);
  assert.equal(evaluatePolicy(policy, [row(9)]).evaluated, 1);
});
