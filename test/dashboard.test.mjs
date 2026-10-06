import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboard, calculateUsageCost } from '../src/dashboard.mjs';

const pricing = {
  schemaVersion: 1,
  currency: 'USD',
  source: 'test fixture',
  effectiveDate: '2026-01-01',
  serviceTier: 'api-standard',
  models: { 'model-a': { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 } },
};

test('does not double count cached input or reasoning output subdivisions', () => {
  const result = calculateUsageCost({
    inputTokens: 1_000_000, cachedInputTokens: 400_000,
    outputTokens: 100_000, reasoningOutputTokens: 80_000,
  }, pricing.models['model-a']);
  assert.equal(result, 2.28);
});

test('keeps known cost as a partial subtotal when another model has no price', () => {
  const dashboard = buildDashboard({
    total: 2, attempts: 2, tasks: 2, modes: { auto: 2 }, sources: { classifier: 1, baseline: 1 },
    models: { 'model-a': 1, 'unknown-model': 1 }, efforts: { low: 2 },
    usage: { turns: 2, totalTokens: 220, coverage: { known: 2, unknown: 0 } },
    usageByModel: {
      'model-a': { turns: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
      'unknown-model': { turns: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
    },
    classifierUsage: { calls: 0, latencyMs: 0 }, classifierUsageByModel: {},
    validation: { passed: 1, failed: 0, unknown: 1, not_run: 0 },
    latency: { measured: 1, totalMs: 25 }, retries: 0,
  }, { pricing, billingMode: 'api' });
  assert.equal(dashboard.cost.coverage, 'partial');
  assert.ok(dashboard.cost.knownSubtotal > 0);
  assert.equal(dashboard.cost.totalEstimate, null);
  assert.deepEqual(dashboard.cost.missingModels, ['unknown-model']);
  assert.equal(dashboard.evidence.validationCoveragePercent, 50);
});

test('subscription mode never presents API estimates as a bill or subscription savings', () => {
  const dashboard = buildDashboard({
    total: 0, attempts: 0, tasks: 0, modes: {}, sources: {}, models: {}, efforts: {},
    usage: { turns: 0, coverage: { known: 0, unknown: 0 } }, usageByModel: {},
    classifierUsage: { calls: 0, latencyMs: 0 }, classifierUsageByModel: {},
    validation: { passed: 0, failed: 0, unknown: 0, not_run: 0 },
  }, { pricing, billingMode: 'subscription' });
  assert.equal(dashboard.cost.totalEstimate, null);
  assert.equal(dashboard.cost.subscriptionSavings, null);
  assert.equal(dashboard.cost.coverage, 'unknown');
  assert.equal(dashboard.measurements.counterfactual.status, 'not_measured');
});
