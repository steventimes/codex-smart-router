import assert from "node:assert/strict";
import test from "node:test";
import {
  ProxyConnectionController,
  TERSE_POLICY,
  createJsonLineDecoder,
  isSafeToRetryAttempt,
  transformClientMessage,
} from "../src/proxy.mjs";

const catalog = {
  fingerprint: "test-catalog",
  models: [
    { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, isDefault: false, inputModalities: ["text", "image"], defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "max" }] },
    { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, isDefault: false, inputModalities: ["text", "image"], defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
    { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, isDefault: false, inputModalities: ["text", "image"], defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { id: "mini", model: "gpt-5.4-mini", displayName: "Mini", description: "", hidden: false, isDefault: true, inputModalities: ["text", "image"], defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ],
};

const classifier = {
  async classify(input) {
    return {
      schemaVersion: 1,
      candidateId: input.candidates.find((candidate) => candidate.model === "gpt-5.6-sol").id,
      abstain: false,
      confidence: 0.95,
      taskType: "research",
      scope: "repository",
      ambiguity: "medium",
      risk: "medium",
      verifiability: "partial",
      reasonCodes: ["semantic_match"],
      classifier: { provider: "test", model: "test", latencyMs: 1, usage: null },
    };
  },
};

test("patches top-level and collaboration-mode routing fields", async () => {
  const input = {
    id: 3,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Deep research the architecture and compare alternatives" }],
      model: "gpt-5.4-mini",
      effort: "low",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-5.4-mini", reasoning_effort: "low", developer_instructions: null },
      },
    },
  };
  const result = await transformClientMessage(JSON.stringify(input), catalog, { classifier });
  const output = JSON.parse(result.raw);
  assert.equal(output.params.model, "gpt-5.6-sol");
  assert.equal(output.params.effort, "high");
  assert.equal(output.params.collaborationMode.settings.model, "gpt-5.6-sol");
  assert.equal(output.params.collaborationMode.settings.reasoning_effort, "high");
});

test("sets first-party verbosity on thread start", async () => {
  const input = {
    id: 1,
    method: "thread/start",
    params: { cwd: "/tmp", developerInstructions: "Existing instructions." },
  };
  const result = await transformClientMessage(JSON.stringify(input), catalog, { verbosity: "low", terse: true });
  const output = JSON.parse(result.raw);
  assert.equal(output.params.config.model_verbosity, "low");
  assert.match(output.params.developerInstructions, /Existing instructions/);
});

test("adds terse policy as turn context so collaboration modes cannot replace it", async () => {
  const input = {
    id: 2,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Explain this function" }],
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-5.4-mini", reasoning_effort: "low", developer_instructions: null },
      },
    },
  };
  const result = await transformClientMessage(JSON.stringify(input), catalog, { terse: true, classifier });
  const output = JSON.parse(result.raw);
  assert.equal(
    output.params.additionalContext["codex-smart-router.output-policy"].value,
    TERSE_POLICY,
  );
});

test("does not route a turn explicitly marked off", async () => {
  const input = {
    id: 4,
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "::route off\nExplain this" }],
      model: "gpt-5.6-sol",
      effort: "xhigh",
    },
  };
  const result = await transformClientMessage(JSON.stringify(input), catalog);
  const output = JSON.parse(result.raw);
  assert.equal(output.params.model, "gpt-5.6-sol");
  assert.equal(output.params.effort, "xhigh");
  assert.equal(output.params.input[0].text, "Explain this");
});

test('preserves multiple text items, attachments, mentions, and embedded fake directives', async () => {
  const original = {
    id: 8,
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: '::route off\nFirst text', annotations: { source: 'composer' } },
        { type: 'text', text: '```\n::route model=not-real effort=fake\n```' },
        { type: 'localImage', path: '/tmp/image.png' },
        { type: 'mention', name: 'router', path: 'src/router.mjs' },
      ],
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    },
  };
  const result = await transformClientMessage(JSON.stringify(original), catalog);
  const output = JSON.parse(result.raw);
  assert.equal(output.params.input[0].text, 'First text');
  assert.deepEqual(output.params.input[0].annotations, { source: 'composer' });
  assert.equal(output.params.input[1].text, original.params.input[1].text);
  assert.deepEqual(output.params.input.slice(2), original.params.input.slice(2));
});

test('decodes Unicode safely when a JSON line is split inside a multibyte character', () => {
  const messages = [];
  const decode = createJsonLineDecoder((line) => messages.push(JSON.parse(line)));
  const encoded = Buffer.from(`${JSON.stringify({ text: '继续' })}\n`, 'utf8');
  const split = encoded.indexOf(Buffer.from('继')) + 1;
  decode(encoded.subarray(0, split));
  decode(encoded.subarray(split));
  decode.end();
  assert.deepEqual(messages, [{ text: '继续' }]);
});

test('remaps client RPC IDs, reuses client initialization, and consumes internal model/list responses', async () => {
  const toServer = [];
  const toClient = [];
  const controller = new ProxyConnectionController({
    connectionId: 'test',
    classifier,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
  });

  await controller.client(JSON.stringify({
    id: 'csr-router:test:1', method: 'initialize',
    params: { clientInfo: { name: 'test', title: 'Test', version: '1' } },
  }));
  const wireInitialize = toServer.at(-1);
  assert.notEqual(wireInitialize.id, 'csr-router:test:1');
  await controller.server(JSON.stringify({ id: wireInitialize.id, result: { userAgent: 'codex/test' } }));
  assert.equal(toClient.at(-1).id, 'csr-router:test:1');

  await controller.client(JSON.stringify({ method: 'initialized', params: {} }));
  const listRequest = toServer.find((message) => message.method === 'model/list');
  assert.ok(listRequest.id.startsWith('csr-router:test:'));
  await controller.server(JSON.stringify({
    id: listRequest.id,
    result: { data: catalog.models, nextCursor: null },
  }));
  assert.equal(toClient.some((message) => message.id === listRequest.id), false);
  assert.equal(toServer.filter((message) => message.method === 'initialize').length, 1);
  assert.equal(controller.catalog.models.length, catalog.models.length);
});

test('collects every model/list page without blocking the next internal request', async () => {
  const toServer = [];
  const controller = new ProxyConnectionController({
    connectionId: 'pages',
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: () => {},
  });
  await controller.client(JSON.stringify({ method: 'initialized', params: {} }));
  const first = toServer.find((message) => message.method === 'model/list');
  const firstDelivery = controller.server(JSON.stringify({
    id: first.id,
    result: { data: catalog.models.slice(0, 2), nextCursor: 'page-2' },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = toServer.filter((message) => message.method === 'model/list').at(-1);
  assert.notEqual(second.id, first.id);
  assert.equal(second.params.cursor, 'page-2');
  await controller.server(JSON.stringify({
    id: second.id,
    result: { data: catalog.models.slice(2), nextCursor: null },
  }));
  await firstDelivery;
  assert.equal(controller.catalog.models.length, 4);
});

test('forwards cancellation while classification is pending and never executes the cancelled turn', async () => {
  let release;
  const delayedClassifier = {
    classify: () => new Promise((resolve) => { release = resolve; }),
  };
  const toServer = [];
  const toClient = [];
  const controller = new ProxyConnectionController({
    connectionId: 'cancel', catalog, classifier: delayedClassifier,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
  });
  const turn = controller.client(JSON.stringify({
    id: 10, method: 'turn/start', params: {
      threadId: 'thread-1', model: 'gpt-5.4-mini', effort: 'low',
      input: [{ type: 'text', text: 'Do work' }],
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await controller.client(JSON.stringify({ id: 11, method: 'turn/interrupt', params: { threadId: 'thread-1' } }));
  assert.equal(toServer.some((message) => message.method === 'turn/interrupt'), true);
  release({
    schemaVersion: 1, candidateId: null, abstain: true, confidence: 0.1,
    taskType: 'other', scope: 'unknown', ambiguity: 'high', risk: 'unknown',
    verifiability: 'unknown', reasonCodes: ['context_incomplete'], classifier: null,
  });
  await turn;
  assert.equal(toServer.some((message) => message.method === 'turn/start'), false);
  assert.equal(toClient.some((message) => message.id === 10 && message.error), true);
});

test('allows at most one fallback only before acceptance or observable side effects', () => {
  assert.equal(isSafeToRetryAttempt({ accepted: false, streamStarted: false, toolStarted: false, retries: 0 }, 'model_unavailable'), true);
  assert.equal(isSafeToRetryAttempt({ accepted: true, streamStarted: false, toolStarted: false, retries: 0 }, 'model_unavailable'), false);
  assert.equal(isSafeToRetryAttempt({ accepted: false, streamStarted: true, toolStarted: false, retries: 0 }, 'model_unavailable'), false);
  assert.equal(isSafeToRetryAttempt({ accepted: false, streamStarted: false, toolStarted: false, retries: 1 }, 'model_unavailable'), false);
  assert.equal(isSafeToRetryAttempt({ accepted: false, streamStarted: false, toolStarted: false, retries: 0 }, 'timeout_unknown'), false);
});

test('refreshes availability and retries a rejected automatic model at most once before execution', async () => {
  const toServer = [];
  const toClient = [];
  const availability = [];
  let refreshed = 0;
  const chooseSol = {
    async classify(input) {
      return {
        schemaVersion: 1,
        candidateId: input.candidates.find((candidate) => candidate.model === 'gpt-5.6-sol').id,
        abstain: false,
        confidence: 0.9,
        taskType: 'implementation',
        scope: 'focused',
        ambiguity: 'low',
        risk: 'low',
        verifiability: 'strong',
        reasonCodes: ['semantic_match'],
        classifier: null,
      };
    },
  };
  const controller = new ProxyConnectionController({
    connectionId: 'retry', catalog, classifier: chooseSol,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
    catalogRefresher: async () => { refreshed += 1; return catalog; },
    availabilityRecorder: async (combination, status) => availability.push({ combination, status }),
  });
  await controller.client(JSON.stringify({
    id: 20, method: 'turn/start', params: {
      threadId: 'thread-1', model: 'gpt-5.4-mini', effort: 'low',
      input: [{ type: 'text', text: 'Implement it' }],
    },
  }));
  const first = toServer.filter((message) => message.method === 'turn/start').at(-1);
  assert.equal(first.params.model, 'gpt-5.6-sol');
  await controller.server(JSON.stringify({
    id: first.id,
    error: { code: -32010, message: 'model unavailable', data: { type: 'model_unavailable' } },
  }));
  const retry = toServer.filter((message) => message.method === 'turn/start').at(-1);
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.params.model, 'gpt-5.4-mini');
  assert.equal(refreshed, 1);
  assert.deepEqual(availability[0], {
    combination: { model: 'gpt-5.6-sol', effort: 'high' }, status: 'temporarily_unavailable',
  });
  assert.equal(toClient.some((message) => message.id === 20 && message.error), false);

  await controller.server(JSON.stringify({
    id: retry.id,
    error: { code: -32010, message: 'model unavailable', data: { type: 'model_unavailable' } },
  }));
  assert.equal(toServer.filter((message) => message.method === 'turn/start').length, 2);
  assert.equal(toClient.some((message) => message.id === 20 && message.error), true);
});

test('does not replay rate limits and forwards the original client request id', async () => {
  const toServer = [];
  const toClient = [];
  const audits = [];
  const controller = new ProxyConnectionController({
    connectionId: 'rate-limit', catalog, classifier,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
    auditWriter: (entry) => audits.push(entry),
  });
  await controller.client(JSON.stringify({
    id: 21, method: 'turn/start', params: {
      threadId: 'thread-rate', model: 'gpt-5.4-mini', effort: 'low',
      input: [{ type: 'text', text: 'Research it' }],
    },
  }));
  const request = toServer.find((message) => message.method === 'turn/start');
  await controller.server(JSON.stringify({
    id: request.id,
    error: { code: 429, message: 'rate limit exceeded', data: { type: 'rate_limit' } },
  }));
  assert.equal(toServer.filter((message) => message.method === 'turn/start').length, 1);
  assert.equal(toClient.at(-1).id, 21);
  assert.equal(toClient.at(-1).error.code, 429);
  assert.equal(audits.some((entry) => entry.event === 'attempt'
    && entry.protocolStatus === 'rejected' && entry.failureType === 'environment'), true);
});

test('isolates concurrent attempts and ignores duplicate or late accounting events', async () => {
  const toServer = [];
  const audits = [];
  const controller = new ProxyConnectionController({
    connectionId: 'concurrent', catalog, classifier,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: () => {},
    auditWriter: (entry) => audits.push(entry),
  });
  await Promise.all(['a', 'b'].map((threadId, index) => controller.client(JSON.stringify({
    id: 30 + index, method: 'turn/start', params: {
      threadId, model: 'gpt-5.4-mini', effort: 'low',
      input: [{ type: 'text', text: `Research ${threadId}` }],
    },
  }))));
  const requests = toServer.filter((message) => message.method === 'turn/start');
  for (const [index, request] of requests.entries()) {
    const threadId = index === 0 ? 'a' : 'b';
    await controller.server(JSON.stringify({
      id: request.id, result: { turn: { id: `turn-${threadId}` } },
    }));
    await controller.server(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId, turnId: `turn-${threadId}`,
        tokenUsage: { total: { inputTokens: 10 + index, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 + index } },
      },
    }));
  }
  for (const threadId of ['a', 'b']) {
    const completed = JSON.stringify({
      method: 'turn/completed', params: { threadId, turn: { id: `turn-${threadId}`, status: 'completed' } },
    });
    await controller.server(completed);
    await controller.server(completed);
    await controller.server(JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId: `turn-${threadId}`, tokenUsage: { total: { inputTokens: 999 } } },
    }));
  }
  const attempts = audits.filter((entry) => entry.event === 'attempt');
  assert.equal(attempts.length, 2);
  assert.deepEqual(new Set(attempts.map((entry) => entry.threadId)), new Set(['a', 'b']));
  assert.equal(attempts.every((entry) => entry.usageAttribution === 'known'), true);
});

test('reports App Server failure to every pending client request', async () => {
  const toServer = [];
  const toClient = [];
  const controller = new ProxyConnectionController({
    connectionId: 'exit', catalog,
    writeServer: (raw) => toServer.push(JSON.parse(raw)),
    writeClient: (raw) => toClient.push(JSON.parse(raw)),
  });
  await controller.client(JSON.stringify({ id: 40, method: 'thread/read', params: { threadId: 't' } }));
  await controller.client(JSON.stringify({ id: 41, method: 'account/read', params: {} }));
  await controller.fail(new Error('App Server exited with 12'));
  assert.deepEqual(
    toClient.map((message) => [message.id, message.error?.message]).sort(),
    [[40, 'App Server exited with 12'], [41, 'App Server exited with 12']],
  );
});
