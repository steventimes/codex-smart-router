import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyConnectionController } from '../src/proxy.mjs';
import { createValidationResult } from '../src/validation.mjs';

const catalog = {
  fingerprint: 'mock-catalog',
  source: 'mock-model-list',
  models: [
    {
      id: 'efficient', model: 'efficient', displayName: 'Efficient', description: 'Mock efficient model.',
      hidden: false, isDefault: true, inputModalities: ['text'], defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }],
      availability: { status: 'verified' },
    },
    {
      id: 'strong', model: 'strong', displayName: 'Strong', description: 'Mock strong model.',
      hidden: false, isDefault: false, inputModalities: ['text'], defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }],
      availability: { status: 'unknown' },
    },
  ],
};

test('mock model/list to execution evidence to next-turn upgrade and off baseline restore', async () => {
  const toServer = [];
  const toClient = [];
  const audit = [];
  let calls = 0;
  const classifier = {
    async classify(input) {
      calls += 1;
      if (calls === 2) assert.equal(input.previous.validation.status, 'failed');
      const desired = calls === 1
        ? input.candidates.find((item) => item.model === 'efficient' && item.effort === 'low')
        : input.candidates.find((item) => item.model === 'strong' && item.effort === 'high');
      return {
        schemaVersion: 1,
        candidateId: desired.id,
        abstain: false,
        confidence: 0.9,
        taskType: 'debugging',
        scope: 'focused',
        ambiguity: 'low',
        risk: 'low',
        verifiability: 'strong',
        reasonCodes: calls === 1 ? ['semantic_match'] : ['verified_failure'],
        classifier: { provider: 'mock', model: 'mock-router', latencyMs: 1, usage: null },
      };
    },
  };
  const controller = new ProxyConnectionController({
    connectionId: 'e2e', catalog, classifier,
    config: {
      automaticEfforts: ['low', 'high'],
      modelProfiles: {
        efficient: { quality: 1, relativeCost: 1, source: 'mock' },
        strong: { quality: 3, relativeCost: 3, source: 'mock' },
      },
    },
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
    auditWriter: async (entry) => audit.push(entry),
  });

  await controller.client(JSON.stringify({
    id: 1, method: 'turn/start', params: {
      threadId: 'thread-1', model: 'efficient', effort: 'low',
      input: [{ type: 'text', text: 'Fix the parser' }],
    },
  }));
  const firstRequest = toServer.find((message) => message.method === 'turn/start');
  assert.equal(firstRequest.params.model, 'efficient');
  assert.equal(firstRequest.params.effort, 'low');
  await controller.server(JSON.stringify({ id: firstRequest.id, result: { turn: { id: 'turn-1' } } }));
  await controller.server(JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: {
      inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120,
    } } },
  }));
  await controller.server(JSON.stringify({
    method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  }));
  await controller.recordValidation('thread-1', 'turn-1', createValidationResult({
    status: 'failed', failureType: 'logic', checkerId: 'unit-tests',
  }));

  await controller.client(JSON.stringify({
    id: 2, method: 'turn/start', params: {
      threadId: 'thread-1', model: 'efficient', effort: 'low',
      input: [{ type: 'text', text: 'Still failing; continue' }],
    },
  }));
  const secondRequest = toServer.filter((message) => message.method === 'turn/start').at(-1);
  assert.equal(secondRequest.params.model, 'strong');
  assert.equal(secondRequest.params.effort, 'high');

  await controller.client(JSON.stringify({
    id: 3, method: 'turn/start', params: {
      threadId: 'thread-1', model: 'efficient', effort: 'low',
      input: [{ type: 'text', text: '::route off\nUse my baseline' }],
    },
  }));
  const offRequest = toServer.filter((message) => message.method === 'turn/start').at(-1);
  assert.equal(offRequest.params.model, 'efficient');
  assert.equal(offRequest.params.effort, 'low');
  assert.equal(offRequest.params.input[0].text, 'Use my baseline');

  assert.ok(audit.some((event) => event.event === 'route' && event.decisionId));
  assert.ok(audit.some((event) => event.event === 'attempt' && event.validationStatus === 'unknown'));
  assert.ok(audit.some((event) => event.event === 'validation' && event.validationStatus === 'failed'));
  assert.equal(toClient.some((message) => message.error), false);
});
