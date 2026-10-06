import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WebSocket, WebSocketServer } from 'ws';
import { appendAuditEvent } from './audit.mjs';
import { normalizeCatalogModel, validateCombination } from './catalog.mjs';
import { routePrompt, extractRouteDirective, SessionRouteState } from './router.mjs';
import { buildScopeContext } from './scope-policy.mjs';
import { createValidationResult } from './validation.mjs';

export const TERSE_POLICY = [
  'Keep final answers concise and information-dense.',
  'Omit filler, repetition, and unnecessary restatement.',
  'Preserve technical precision, safety warnings, commands, paths, and exact error text.',
  'Use complete sentences whenever compression could create ambiguity.',
].join(' ');

function textInputs(params) {
  return (params.input ?? []).filter((item) => item?.type === 'text' && typeof item.text === 'string');
}

export async function transformClientMessage(raw, catalog, options = {}) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { raw: text, decision: null };
  }

  if (message.method === 'thread/start' && message.params) {
    message.params.config = {
      ...(message.params.config ?? {}),
      model_verbosity: options.verbosity ?? 'low',
    };
    return { raw: JSON.stringify(message), decision: null };
  }
  if (message.method !== 'turn/start' || !message.params) return { raw: text, decision: null };

  const inputs = textInputs(message.params);
  const first = inputs[0];
  const extracted = first ? extractRouteDirective(first.text) : { prompt: '', directive: null };
  if (first && extracted.directive) first.text = extracted.prompt;
  const prompt = inputs.map((item) => item.text).join('\n\n');
  const hasImages = (message.params.input ?? []).some((item) => item?.type === 'image' || item?.type === 'localImage');
  const modeSettings = message.params.collaborationMode?.settings;
  const baselineModel = modeSettings?.model ?? message.params.model;
  const baselineEffort = modeSettings?.reasoning_effort ?? message.params.effort;
  const decision = await routePrompt(prompt, catalog, {
    config: options.config,
    hasImages,
    context: options.context,
    history: options.history,
    classifier: options.classifier,
    baseline: baselineModel && baselineEffort ? { model: baselineModel, effort: baselineEffort } : undefined,
    session: options.session,
    directive: extracted.directive,
    repositorySummary: options.repositorySummary,
  });

  if (decision.mode !== 'off') {
    message.params.model = decision.execution.model;
    message.params.effort = decision.execution.effort;
    if (modeSettings) {
      modeSettings.model = decision.execution.model;
      modeSettings.reasoning_effort = decision.execution.effort;
    }
  }
  if (options.terse) {
    message.params.additionalContext = {
      ...(message.params.additionalContext ?? {}),
      'codex-smart-router.output-policy': { kind: 'application', value: TERSE_POLICY },
    };
  }
  if (options.scopePolicy) {
    const scope = buildScopeContext(typeof options.scopePolicy === 'string'
      ? { policy: options.scopePolicy }
      : options.scopePolicy);
    message.params.additionalContext = {
      ...(message.params.additionalContext ?? {}),
      'codex-smart-router.scope-policy': { kind: scope.kind, value: scope.text },
    };
  }
  return { raw: JSON.stringify(message), decision };
}

export function createJsonLineDecoder(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = (chunk) => {
    pending += decoder.write(chunk);
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line) onLine(line);
    }
  };
  consume.end = () => {
    pending += decoder.end();
    const line = pending.trim();
    pending = '';
    if (line) onLine(line);
  };
  return consume;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const field = (camel, snake) => Number.isFinite(usage[camel]) ? usage[camel]
    : Number.isFinite(usage[snake]) ? usage[snake] : null;
  return {
    inputTokens: field('inputTokens', 'input_tokens'),
    cachedInputTokens: field('cachedInputTokens', 'cached_input_tokens'),
    outputTokens: field('outputTokens', 'output_tokens'),
    reasoningOutputTokens: field('reasoningOutputTokens', 'reasoning_output_tokens'),
    totalTokens: field('totalTokens', 'total_tokens'),
  };
}

function usageDelta(current, base) {
  const normalizedCurrent = normalizeUsage(current);
  const normalizedBase = normalizeUsage(base) ?? {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  };
  if (!normalizedCurrent) return { usage: null, attribution: 'unknown' };
  const result = {};
  for (const field of Object.keys(normalizedCurrent)) {
    if (!Number.isFinite(normalizedCurrent[field]) || !Number.isFinite(normalizedBase[field])
      || normalizedCurrent[field] < normalizedBase[field]) {
      return { usage: null, attribution: 'unknown' };
    }
    result[field] = normalizedCurrent[field] - normalizedBase[field];
  }
  return { usage: result, attribution: 'known' };
}

function catalogFingerprint(models) {
  return createHash('sha256').update(JSON.stringify(models.map((model) => ({
    model: model.model,
    id: model.id,
    efforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
  })))).digest('hex');
}

export function isSafeToRetryAttempt(attempt, failureType) {
  return failureType === 'model_unavailable'
    && attempt?.accepted === false
    && attempt?.streamStarted === false
    && attempt?.toolStarted === false
    && (attempt?.retries ?? 0) < 1;
}

async function maybeAwait(value) {
  return value && typeof value.then === 'function' ? value : undefined;
}

export class ProxyConnectionController {
  constructor({
    connectionId = randomUUID(),
    catalog = null,
    classifier = null,
    config = null,
    verbosity = 'low',
    terse = false,
    scopePolicy = null,
    policy = null,
    mode = 'auto',
    cliPin = null,
    writeServer,
    writeClient,
    auditWriter = async () => {},
    catalogRefresher = null,
    availabilityRecorder = async () => {},
  }) {
    this.connectionId = connectionId;
    this.catalog = catalog;
    this.classifier = classifier;
    this.config = config;
    this.verbosity = verbosity;
    this.terse = terse;
    this.scopePolicy = scopePolicy;
    this.policy = policy;
    this.mode = mode;
    this.cliPin = cliPin;
    this.writeServer = writeServer;
    this.writeClient = writeClient;
    this.auditWriter = auditWriter;
    this.catalogRefresher = catalogRefresher;
    this.availabilityRecorder = availabilityRecorder;
    this.sequence = 0;
    this.clientRequests = new Map();
    this.serverRequests = new Map();
    this.internalRequests = new Map();
    this.pendingClassifications = new Map();
    this.pendingAttempts = new Map();
    this.activeAttempts = new Map();
    this.completedAttempts = new Map();
    this.threadContexts = new Map();
    this.threadHistories = new Map();
    this.threadSessions = new Map();
    this.threadTotals = new Map();
    this.catalogPromise = catalog ? Promise.resolve(catalog) : null;
    this.closed = false;
  }

  #id(namespace) {
    return `csr-${namespace}:${this.connectionId}:${++this.sequence}`;
  }

  async #toServer(message) {
    await maybeAwait(this.writeServer(typeof message === 'string' ? message : JSON.stringify(message)));
  }

  async #toClient(message) {
    await maybeAwait(this.writeClient(typeof message === 'string' ? message : JSON.stringify(message)));
  }

  #wireClientRequest(message) {
    const wireId = this.#id('client');
    this.clientRequests.set(wireId, { originalId: message.id, method: message.method });
    return { ...message, id: wireId };
  }

  async #internalRequest(method, params) {
    const id = this.#id('router');
    const promise = new Promise((resolve, reject) => this.internalRequests.set(id, { method, resolve, reject }));
    await this.#toServer({ id, method, params });
    return promise;
  }

  refreshCatalog() {
    if (this.catalogPromise && !this.catalog) return this.catalogPromise;
    this.catalogPromise = (async () => {
      const data = [];
      let cursor = null;
      const seen = new Set();
      do {
        const response = await this.#internalRequest('model/list', { cursor, limit: 100, includeHidden: true });
        if (!Array.isArray(response?.data)) throw new Error('Invalid model/list response');
        data.push(...response.data);
        cursor = response.nextCursor ?? null;
        if (cursor !== null) {
          if (seen.has(cursor)) throw new Error(`Repeated model/list cursor: ${cursor}`);
          seen.add(cursor);
        }
      } while (cursor !== null);
      const models = data.map((model) => normalizeCatalogModel(model, {
        source: 'app-server-model-list', defaultModalities: ['text', 'image'],
      }));
      if (!models.some((model) => !model.hidden)) throw new Error('Codex returned no selectable models');
      this.catalog = {
        schemaVersion: 2,
        protocolVersion: 2,
        source: 'app-server-model-list',
        fetchedAt: new Date().toISOString(),
        stale: false,
        fingerprint: catalogFingerprint(models),
        models,
      };
      return this.catalog;
    })();
    return this.catalogPromise;
  }

  async client(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      await this.#toServer(text);
      return;
    }

    if (message.id !== undefined && message.id !== null && !message.method) {
      const pending = this.serverRequests.get(String(message.id));
      if (!pending) {
        await this.#toServer(message);
        return;
      }
      this.serverRequests.delete(String(message.id));
      await this.#toServer({ ...message, id: pending.serverId });
      return;
    }

    if (message.method === 'initialized') {
      await this.#toServer(message);
      if (!this.catalog) this.refreshCatalog().catch((error) => this.fail(error));
      return;
    }

    if (message.method === 'turn/interrupt') {
      const pending = this.pendingClassifications.get(message.params?.threadId);
      if (pending) pending.cancelled = true;
      const wired = message.id === undefined ? message : this.#wireClientRequest(message);
      await this.#toServer(wired);
      return;
    }

    if (message.method !== 'turn/start') {
      const wired = message.id === undefined ? message : this.#wireClientRequest(message);
      await this.#toServer(wired);
      return;
    }

    const threadId = message.params?.threadId;
    const classificationState = { cancelled: false, originalId: message.id };
    if (threadId) this.pendingClassifications.set(threadId, classificationState);
    let transformed;
    try {
      const catalog = this.catalog ?? await this.catalogPromise;
      if (!catalog) throw new Error('Model catalog is unavailable; initialize the App Server connection first');
      const session = this.threadSessions.get(threadId) ?? new SessionRouteState({ mode: this.mode, cliPin: this.cliPin });
      this.threadSessions.set(threadId, session);
      transformed = await transformClientMessage(text, catalog, {
        config: this.config,
        verbosity: this.verbosity,
        terse: this.terse,
        scopePolicy: this.scopePolicy,
        classifier: this.classifier,
        context: this.threadContexts.get(threadId),
        history: this.threadHistories.get(threadId) ?? [],
        session,
        policy: this.policy,
      });
    } catch (error) {
      if (message.id !== undefined) await this.#toClient({ id: message.id, error: { code: -32602, message: error.message } });
      if (threadId) this.pendingClassifications.delete(threadId);
      return;
    }
    if (threadId) this.pendingClassifications.delete(threadId);
    if (classificationState.cancelled) {
      if (message.id !== undefined) {
        await this.#toClient({ id: message.id, error: { code: -32800, message: 'Turn cancelled before routing completed' } });
      }
      return;
    }

    const transformedMessage = JSON.parse(transformed.raw);
    const wired = transformedMessage.id === undefined ? transformedMessage : this.#wireClientRequest(transformedMessage);
    if (transformed.decision) {
      const decision = transformed.decision;
      const attemptId = randomUUID();
      const taskId = this.threadContexts.get(threadId)?.taskId ?? randomUUID();
      decision.taskId = taskId;
      const attempt = {
        attemptId,
        taskId,
        decision,
        threadId,
        turnId: null,
        requestId: wired.id,
        accepted: false,
        streamStarted: false,
        toolStarted: false,
        retries: 0,
        baseUsage: this.threadTotals.get(threadId) ?? null,
        usage: null,
        usageAttribution: 'unknown',
        completed: false,
        requestMessage: wired,
        retryOf: null,
      };
      this.pendingAttempts.set(String(wired.id), attempt);
      const history = this.threadHistories.get(threadId) ?? [];
      history.push(decision.prompt);
      this.threadHistories.set(threadId, history.slice(-6));
      await this.auditWriter({
        schemaVersion: 2,
        event: 'route',
        eventId: decision.decisionId,
        decisionId: decision.decisionId,
        taskId,
        threadId,
        catalogFingerprint: this.catalog?.fingerprint ?? null,
        routeSource: decision.source,
        model: decision.execution.model,
        effort: decision.execution.effort,
        mode: decision.mode,
        overridden: decision.overridden,
        classifierConfidence: decision.classifierConfidence,
        taskType: decision.taskType,
        reasonCodes: decision.reasonCodes,
        classifier: decision.classifier,
        anonymousFeatures: {
          taskType: decision.taskType,
          risk: decision.features?.risk ?? 'unknown',
          verifiability: decision.features?.verifiability ?? 'unknown',
          scope: decision.features?.scope ?? 'unknown',
          ambiguity: decision.features?.ambiguity ?? 'unknown',
        },
      });
    }
    await this.#toServer(wired);
  }

  async server(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      await this.#toClient(text);
      return;
    }

    if (message.id !== undefined && message.id !== null && !message.method) {
      const internal = this.internalRequests.get(String(message.id));
      if (internal) {
        this.internalRequests.delete(String(message.id));
        if (message.error) internal.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else internal.resolve(message.result);
        if (internal.method === 'model/list' && message.result?.nextCursor == null && this.catalogPromise) {
          await this.catalogPromise;
        }
        return;
      }
      const pending = this.clientRequests.get(String(message.id));
      if (pending) {
        this.clientRequests.delete(String(message.id));
        const attempt = this.pendingAttempts.get(String(message.id));
        if (attempt) {
          this.pendingAttempts.delete(String(message.id));
          const rejection = this.#modelRejection(message.error);
          if (rejection && isSafeToRetryAttempt(attempt, 'model_unavailable')) {
            const retried = await this.#retryRejectedAttempt(attempt, pending.originalId, rejection);
            if (retried) return;
          }
          if (message.error) await this.#auditRejectedAttempt(attempt, this.#failureType(message.error));
          if (!message.error) {
            attempt.accepted = true;
            attempt.turnId = message.result?.turn?.id ?? message.result?.turnId ?? null;
            if (attempt.turnId) this.activeAttempts.set(`${attempt.threadId}:${attempt.turnId}`, attempt);
          }
        }
        await this.#toClient({ ...message, id: pending.originalId });
        return;
      }
    }

    if (message.id !== undefined && message.id !== null && message.method) {
      const clientId = this.#id('server');
      this.serverRequests.set(clientId, { serverId: message.id, method: message.method });
      await this.#toClient({ ...message, id: clientId });
      return;
    }

    if (message.method === 'thread/tokenUsage/updated') this.#recordUsage(message.params);
    if (message.method === 'item/agentMessage/delta') this.#markAttempt(message.params, 'streamStarted');
    if (message.method?.includes('commandExecution') && message.method.endsWith('/started')) {
      this.#markAttempt(message.params, 'toolStarted');
    }
    if (message.method === 'turn/completed') await this.#completeAttempt(message.params);
    await this.#toClient(message);
  }

  #modelRejection(error) {
    if (!error) return null;
    const type = String(error.data?.type ?? error.data?.code ?? '').toLowerCase();
    const message = String(error.message ?? '').toLowerCase();
    if (type.includes('rate_limit') || error.code === 429 || message.includes('rate limit')) return null;
    if (type.includes('permission') || type.includes('denied') || message.includes('permission denied')) {
      return { status: 'denied', failureType: 'model_unavailable' };
    }
    if (type.includes('model_unavailable') || type.includes('model_not_found')
      || message.includes('model unavailable') || message.includes('model not found')) {
      return { status: 'temporarily_unavailable', failureType: 'model_unavailable' };
    }
    return null;
  }

  #failureType(error) {
    const type = String(error?.data?.type ?? error?.data?.code ?? '').toLowerCase();
    const message = String(error?.message ?? '').toLowerCase();
    if (type.includes('model_unavailable') || type.includes('model_not_found')
      || message.includes('model unavailable') || message.includes('model not found')) return 'model_unavailable';
    if (type.includes('permission') || type.includes('auth') || type.includes('denied')
      || message.includes('permission') || message.includes('unauthorized')) return 'permission';
    if (type.includes('timeout') || message.includes('timed out')) return 'timeout';
    if (type.includes('cancel') || message.includes('cancel')) return 'cancelled';
    return 'environment';
  }

  async #auditRejectedAttempt(attempt, failureType) {
    await this.auditWriter({
      schemaVersion: 2,
      event: 'attempt',
      eventId: `${attempt.attemptId}:attempt`,
      decisionId: attempt.decision.decisionId,
      taskId: attempt.taskId,
      threadId: attempt.threadId,
      attemptId: attempt.attemptId,
      model: attempt.decision.execution.model,
      effort: attempt.decision.execution.effort,
      routeSource: attempt.decision.source,
      protocolStatus: 'rejected',
      validationStatus: 'not_run',
      failureType,
      usage: null,
      usageAttribution: 'unknown',
      retryOf: attempt.retryOf,
    });
  }

  async #retryRejectedAttempt(attempt, originalId, rejection) {
    const rejected = attempt.decision.execution;
    const fallback = attempt.decision.baseline;
    if (!fallback || (fallback.model === rejected.model && fallback.effort === rejected.effort)) return false;
    await this.availabilityRecorder(rejected, rejection.status);
    if (this.catalogRefresher) {
      this.catalog = await this.catalogRefresher();
      this.catalogPromise = Promise.resolve(this.catalog);
    } else {
      this.catalog = null;
      this.catalogPromise = null;
      await this.refreshCatalog();
    }
    try {
      validateCombination(this.catalog, fallback);
    } catch {
      return false;
    }
    await this.#auditRejectedAttempt(attempt, rejection.failureType);
    const requestMessage = structuredClone(attempt.requestMessage);
    requestMessage.params.model = fallback.model;
    requestMessage.params.effort = fallback.effort;
    if (requestMessage.params.collaborationMode?.settings) {
      requestMessage.params.collaborationMode.settings.model = fallback.model;
      requestMessage.params.collaborationMode.settings.reasoning_effort = fallback.effort;
    }
    const wireId = this.#id('client');
    requestMessage.id = wireId;
    this.clientRequests.set(wireId, { originalId, method: 'turn/start' });
    const retry = {
      ...attempt,
      attemptId: randomUUID(),
      requestId: wireId,
      retries: attempt.retries + 1,
      retryOf: attempt.attemptId,
      decision: { ...attempt.decision, execution: fallback, source: 'fallback' },
      requestMessage,
    };
    this.pendingAttempts.set(wireId, retry);
    await this.#toServer(requestMessage);
    return true;
  }

  #markAttempt(params, field) {
    const key = `${params?.threadId}:${params?.turnId}`;
    const attempt = this.activeAttempts.get(key);
    if (attempt) attempt[field] = true;
  }

  #recordUsage(params = {}) {
    const total = params.tokenUsage?.total;
    if (params.threadId && total) this.threadTotals.set(params.threadId, total);
    const attempt = this.activeAttempts.get(`${params.threadId}:${params.turnId}`);
    if (!attempt || attempt.completed) return;
    const delta = usageDelta(total, attempt.baseUsage);
    attempt.usage = delta.usage;
    attempt.usageAttribution = delta.attribution;
  }

  async #completeAttempt(params = {}) {
    const threadId = params.threadId;
    const turn = params.turn ?? {};
    const attempt = this.activeAttempts.get(`${threadId}:${turn.id}`);
    if (!attempt || attempt.completed) return;
    attempt.completed = true;
    this.activeAttempts.delete(`${threadId}:${turn.id}`);
    const validation = createValidationResult({ protocolStatus: turn.status });
    this.threadContexts.set(threadId, {
      taskId: attempt.taskId,
      previousDecision: attempt.decision,
      previousUsage: attempt.usage,
      previousStatus: turn.status,
      previousValidation: validation,
      previousFailureType: null,
      contextIncomplete: false,
    });
    this.completedAttempts.set(`${threadId}:${turn.id}`, attempt);
    await this.auditWriter({
      schemaVersion: 2,
      event: 'attempt',
      eventId: `${attempt.attemptId}:attempt`,
      decisionId: attempt.decision.decisionId,
      taskId: attempt.taskId,
      threadId,
      turnId: turn.id,
      attemptId: attempt.attemptId,
      model: attempt.decision.execution.model,
      effort: attempt.decision.execution.effort,
      routeSource: attempt.decision.source,
      protocolStatus: turn.status,
      validationStatus: 'unknown',
      durationMs: turn.durationMs ?? null,
      usage: attempt.usage,
      usageAttribution: attempt.usageAttribution,
      retryOf: attempt.retryOf,
    });
  }

  async recordValidation(threadId, turnId, validation) {
    const attempt = this.completedAttempts.get(`${threadId}:${turnId}`);
    if (!attempt) throw new Error(`No completed attempt found for ${threadId}/${turnId}`);
    const context = this.threadContexts.get(threadId) ?? {};
    this.threadContexts.set(threadId, {
      ...context,
      previousValidation: validation,
      previousFailureType: validation.failureType,
    });
    await this.auditWriter({
      schemaVersion: 2,
      event: 'validation',
      eventId: `${attempt.attemptId}:validation:${validation.status}`,
      decisionId: attempt.decision.decisionId,
      taskId: attempt.taskId,
      threadId,
      turnId,
      attemptId: attempt.attemptId,
      validationStatus: validation.status,
      failureType: validation.failureType,
      reasonCodes: validation.checkerId ? [`checker:${validation.checkerId}`] : [],
    });
  }

  async fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [wireId, pending] of this.clientRequests) {
      await this.#toClient({ id: pending.originalId, error: { code: -32000, message: error.message } });
      this.clientRequests.delete(wireId);
    }
    for (const pending of this.internalRequests.values()) pending.reject(error);
    this.internalRequests.clear();
  }
}

export async function startProxy({
  catalog = null,
  codexPath = 'codex',
  classifier,
  config,
  verbosity = 'low',
  terse = false,
  scopePolicy = null,
  policy = null,
  mode = 'auto',
  cliPin = null,
  audit = true,
  auditPath,
  spawnImpl,
} = {}) {
  const { spawn } = await import('node:child_process');
  const spawnChild = spawnImpl ?? spawn;
  const authToken = randomBytes(32).toString('base64url');
  const children = new Set();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }) => req.headers.authorization === `Bearer ${authToken}`,
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (socket) => {
    const child = spawnChild(codexPath, [
      'app-server', '--listen', 'stdio://', '-c', `model_verbosity=${JSON.stringify(verbosity)}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stderr = '';
    const controller = new ProxyConnectionController({
      catalog,
      classifier,
      config,
      verbosity,
      terse,
      scopePolicy,
      policy,
      mode,
      cliPin,
      writeServer: (raw) => new Promise((resolve, reject) => {
        child.stdin.write(`${raw}\n`, (error) => error ? reject(error) : resolve());
      }),
      writeClient: (raw) => new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) return resolve();
        socket.send(raw, (error) => error ? reject(error) : resolve());
      }),
      auditWriter: audit ? (entry) => appendAuditEvent(entry, auditPath) : async () => {},
    });
    const decode = createJsonLineDecoder((line) => {
      controller.server(line).catch((error) => controller.fail(error));
    });
    child.stdout.on('data', decode);
    child.stdout.on('end', () => decode.end());
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000); });
    socket.on('message', (data) => {
      controller.client(data).catch((error) => controller.fail(error));
    });
    socket.on('close', () => {
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
    });
    child.on('error', (error) => controller.fail(error));
    child.on('exit', (code, signal) => {
      children.delete(child);
      const reason = signal ? `Codex App Server exited from ${signal}`
        : code === 0 ? 'Codex App Server exited'
          : (stderr.trim() || `Codex App Server exited with ${code}`);
      controller.fail(new Error(reason));
      if (socket.readyState === WebSocket.OPEN) socket.close(code === 0 ? 1000 : 1011, reason.slice(0, 120));
    });
  });

  const address = wss.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    authToken,
    async close() {
      for (const child of children) if (!child.killed) child.kill('SIGTERM');
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
