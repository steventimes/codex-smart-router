import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogBoundCodexClassifier,
  CodexClassifier,
  OpenAICompatibleClassifier,
  createClassifier,
  validateClassification,
} from '../src/classifier.mjs';

const candidate = { id: 'candidate-abc', model: 'model-a', effort: 'new-effort' };
const result = {
  schemaVersion: 1,
  candidateId: candidate.id,
  abstain: false,
  confidence: 0.88,
  taskType: 'implementation',
  scope: 'focused',
  ambiguity: 'low',
  risk: 'low',
  verifiability: 'strong',
  reasonCodes: ['semantic_match'],
};

function input(overrides = {}) {
  return {
    prompt: 'Create a focused parser change',
    history: [],
    candidates: [candidate],
    ...overrides,
  };
}

test('Responses backend uses strict schema and parses token subdivisions without double counting', async () => {
  let request;
  const classifier = new OpenAICompatibleClassifier({
    protocol: 'responses',
    apiKey: 'test-key',
    model: 'classifier-model',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output_text: JSON.stringify(result),
        usage: {
          input_tokens: 250,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens: 40,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 290,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const routed = await classifier.classify(input());
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.store, false);
  assert.equal(routed.candidateId, candidate.id);
  assert.equal(routed.classifier.usage.outputTokens, 40);
  assert.equal(routed.classifier.usage.reasoningOutputTokens, 12);
});

test('Chat Completions and non-strict local Responses use distinct adapters', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify(result) }), { status: 200 });
  };
  const chat = new OpenAICompatibleClassifier({
    protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local', fetchImpl,
    strictJsonSchema: false,
  });
  const responses = new OpenAICompatibleClassifier({
    protocol: 'responses', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local', fetchImpl,
    strictJsonSchema: false,
  });
  assert.equal((await chat.classify(input())).candidateId, candidate.id);
  assert.equal((await responses.classify(input())).candidateId, candidate.id);
  assert.equal(seen[0].body.response_format.type, 'json_object');
  assert.equal(seen[1].body.text.format.type, 'json_object');
});

test('rejects malformed JSON and candidate IDs outside the exact request', async () => {
  const malformed = new OpenAICompatibleClassifier({
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'local',
    fetchImpl: async () => new Response(JSON.stringify({ output_text: '{bad' }), { status: 200 }),
  });
  await assert.rejects(() => malformed.classify(input()), /invalid JSON/i);
  assert.throws(() => validateClassification({ ...result, candidateId: 'invented' }, [candidate.id]), /unknown candidate/i);
});

test('enforces input bounds and timeout', async () => {
  let body;
  const bounded = new OpenAICompatibleClassifier({
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'local', maxInputChars: 600,
    fetchImpl: async (_url, options) => {
      body = options.body;
      return new Response(JSON.stringify({ output_text: JSON.stringify(result) }), { status: 200 });
    },
  });
  await bounded.classify(input({ prompt: 'x'.repeat(10_000), history: ['secret'.repeat(100)] }));
  assert.ok(JSON.parse(body).input.length <= 600);

  const timed = new OpenAICompatibleClassifier({
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'local', timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  await assert.rejects(() => timed.classify(input()), /timed out|timeout|aborted/i);
});

test('does not infer a paid backend from OPENAI_API_KEY in auto mode', () => {
  const classifier = createClassifier({
    mode: 'auto',
    env: { OPENAI_API_KEY: 'present-but-not-authorized-for-routing' },
    nativeCombination: { model: 'model-a', effort: 'new-effort' },
  });
  assert.equal(classifier.provider, 'codex-native');
});

test('requires explicit trust for an insecure non-loopback HTTP classifier', () => {
  assert.throws(() => new OpenAICompatibleClassifier({
    baseUrl: 'http://gpu.example.test:8000/v1', model: 'local',
  }), /HTTPS.*explicit trust/i);
});

test('rejects credentials or query secrets embedded in classifier URLs', () => {
  assert.throws(() => new OpenAICompatibleClassifier({
    baseUrl: 'https://user:secret@gpu.example.test/v1', model: 'local',
  }), /credentials/i);
  assert.throws(() => new OpenAICompatibleClassifier({
    baseUrl: 'https://gpu.example.test/v1?token=secret', model: 'local',
  }), /query/i);
});

test('catalog-bound native classification can use a legal baseline outside the bounded candidates', () => {
  const classifier = new CatalogBoundCodexClassifier();
  assert.deepEqual(classifier.resolveCombination({
    baseline: { model: 'baseline-model', effort: 'novel' },
    candidates: [{ id: 'other', model: 'other-model', effort: 'low' }],
  }), { model: 'baseline-model', effort: 'novel' });
});

test('native classifier requires a legal explicit combination and recursion guard', () => {
  assert.throws(() => new CodexClassifier(), /model and effort/i);
  assert.throws(() => createClassifier({
    mode: 'codex',
    nativeCombination: { model: 'model-a', effort: 'low' },
    env: { CODEX_SMART_ROUTER_CLASSIFIER: '1' },
  }), /recursive/i);
});
