import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AppServerClient } from './app-server-client.mjs';

const execFileAsync = promisify(execFile);
const CATALOG_SCHEMA_VERSION = 2;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableFingerprint(value) {
  return hash(JSON.stringify(value));
}

function normalizeEfforts(raw) {
  const source = raw.supportedReasoningEfforts ?? raw.supported_reasoning_levels ?? [];
  if (!Array.isArray(source)) throw new Error('Model supported reasoning efforts must be an array');
  const seen = new Set();
  return source.flatMap((entry) => {
    const reasoningEffort = nonEmptyString(
      typeof entry === 'string' ? entry : (entry?.reasoningEffort ?? entry?.effort),
    );
    if (!reasoningEffort || seen.has(reasoningEffort)) return [];
    seen.add(reasoningEffort);
    return [{ reasoningEffort, description: nonEmptyString(entry?.description) ?? '' }];
  });
}

export function normalizeCatalogModel(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Catalog model must be an object');
  const model = nonEmptyString(raw.model ?? raw.slug);
  const id = nonEmptyString(raw.id ?? raw.slug ?? raw.model);
  if (!model || !id) throw new Error('Catalog model is missing model or id');
  const supportedReasoningEfforts = normalizeEfforts(raw);
  const defaultReasoningEffort = nonEmptyString(raw.defaultReasoningEffort ?? raw.default_reasoning_level);
  if (defaultReasoningEffort && supportedReasoningEfforts.length > 0
    && !supportedReasoningEfforts.some((entry) => entry.reasoningEffort === defaultReasoningEffort)) {
    throw new Error(`${model} has a default reasoning effort that is not advertised`);
  }

  let inputModalities;
  let modalityEvidence;
  if (Array.isArray(raw.inputModalities ?? raw.input_modalities)) {
    inputModalities = [...(raw.inputModalities ?? raw.input_modalities)];
    modalityEvidence = 'catalog';
  } else if (Array.isArray(options.defaultModalities)) {
    inputModalities = [...options.defaultModalities];
    modalityEvidence = 'protocol-default';
  } else {
    inputModalities = null;
    modalityEvidence = 'unknown';
  }

  return {
    model,
    id,
    displayName: nonEmptyString(raw.displayName ?? raw.display_name) ?? model,
    description: typeof raw.description === 'string' ? raw.description : '',
    supportedReasoningEfforts,
    defaultReasoningEffort,
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : raw.visibility === 'hide',
    isDefault: Boolean(raw.isDefault ?? raw.is_default),
    inputModalities,
    modalityEvidence,
    upgrade: nonEmptyString(raw.upgrade),
    upgradeInfo: raw.upgradeInfo ?? raw.upgrade_info ?? null,
    serviceTiers: raw.serviceTiers ?? raw.service_tiers ?? [],
    defaultServiceTier: raw.defaultServiceTier ?? raw.default_service_tier ?? null,
    multiAgentVersion: raw.multiAgentVersion ?? raw.multi_agent_version ?? null,
    source: options.source ?? 'unknown',
    availability: {
      status: 'unknown',
      checkedAt: null,
      provider: options.provider ?? null,
      identityHash: options.identityHash ?? null,
      effort: null,
      reason: null,
    },
  };
}

function catalogModels(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models)) throw new Error('Codex model catalog is invalid');
  return models;
}

export function validateCombination(catalog, combination, options = {}) {
  const models = catalogModels(catalog);
  const model = models.find((entry) => entry.model === combination.model || entry.id === combination.model);
  if (!model || (model.hidden && !options.allowHidden)) {
    const legalModels = models.filter((entry) => !entry.hidden).map((entry) => entry.model);
    throw new Error(`Model is not selectable: ${combination.model}. Legal models: ${legalModels.join(', ') || 'none'}`);
  }
  const efforts = normalizeEfforts(model).map((entry) => entry.reasoningEffort);
  if (efforts.length === 0) {
    if ((combination.effort === null || combination.effort === undefined) && options.allowOmittedEffort) {
      return { model: model.model, effort: null };
    }
    throw new Error(`${model.model} does not advertise any selectable reasoning efforts`);
  }
  const requestedEffort = combination.effort ?? model.defaultReasoningEffort;
  if (!requestedEffort || !efforts.includes(requestedEffort)) {
    throw new Error(`${model.model} does not support reasoning effort ${requestedEffort ?? '(omitted)'}. Legal efforts: ${efforts.join(', ')}`);
  }
  return { model: model.model, effort: requestedEffort };
}

export function defaultCatalogCacheDirectory(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'smart-router', 'catalogs');
}

async function defaultDebugCatalogLoader(codexPath, timeoutMs) {
  const { stdout } = await execFileAsync(codexPath, ['debug', 'models'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed.models)) throw new Error('Codex debug models returned an invalid catalog');
  return parsed.models;
}

export class ModelRegistry {
  constructor({
    codexPath = 'codex',
    provider = 'openai',
    identityScope = 'unresolved',
    binaryVersion = 'unknown',
    binaryFingerprint = null,
    cacheDirectory = defaultCatalogCacheDirectory(),
    ttlMs = 15 * 60_000,
    timeoutMs = 15_000,
    now = () => new Date(),
    clientFactory = async () => new AppServerClient({ codexPath, timeoutMs }),
    debugCatalogLoader = defaultDebugCatalogLoader,
  } = {}) {
    this.codexPath = codexPath;
    this.provider = provider;
    this.identityScope = identityScope;
    this.binaryVersion = binaryVersion;
    this.binaryFingerprint = binaryFingerprint ?? hash(`${codexPath}\0${binaryVersion}`);
    this.cacheDirectory = cacheDirectory;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.clientFactory = clientFactory;
    this.debugCatalogLoader = debugCatalogLoader;
    this.refreshPromise = null;
    this.lastSnapshot = null;
  }

  scope() {
    return {
      identityHash: hash(this.identityScope),
      provider: this.provider,
      binaryFingerprint: this.binaryFingerprint,
    };
  }

  cachePath() {
    return join(this.cacheDirectory, `${stableFingerprint(this.scope())}.json`);
  }

  async #readCache() {
    try {
      const value = JSON.parse(await readFile(this.cachePath(), 'utf8'));
      if (value.schemaVersion !== CATALOG_SCHEMA_VERSION) return null;
      if (stableFingerprint(value.scope) !== stableFingerprint(this.scope())) return null;
      if (!Array.isArray(value.models)) return null;
      const expiresAt = Date.parse(value.expiresAt);
      return { ...value, stale: !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime() };
    } catch {
      return null;
    }
  }

  async #writeCache(snapshot) {
    await mkdir(dirname(this.cachePath()), { recursive: true, mode: 0o700 });
    const temporary = `${this.cachePath()}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.cachePath());
  }

  async discover({ refresh = false } = {}) {
    if (!refresh) {
      const cached = await this.#readCache();
      if (cached && !cached.stale) {
        this.lastSnapshot = cached;
        return structuredClone(cached);
      }
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.#refresh().finally(() => { this.refreshPromise = null; });
    }
    return structuredClone(await this.refreshPromise);
  }

  async #refresh() {
    let rawModels;
    let source = 'app-server-model-list';
    let client;
    try {
      client = await this.clientFactory();
      rawModels = await client.listModels({ includeHidden: true });
    } catch (appServerError) {
      if (!this.debugCatalogLoader) throw appServerError;
      try {
        rawModels = await this.debugCatalogLoader(this.codexPath, this.timeoutMs);
        source = 'codex-debug-models';
      } catch (debugError) {
        throw new AggregateError([appServerError, debugError], 'Could not discover the Codex model catalog');
      }
    } finally {
      await client?.close?.();
    }

    const scope = this.scope();
    const models = rawModels.map((raw) => normalizeCatalogModel(raw, {
      source,
      provider: this.provider,
      identityHash: scope.identityHash,
      defaultModalities: source === 'app-server-model-list' ? ['text', 'image'] : undefined,
    }));
    if (!models.some((model) => !model.hidden)) throw new Error('Codex returned no selectable models');
    const fetchedAt = this.now();
    const fingerprint = stableFingerprint(models.map((model) => ({
      model: model.model,
      id: model.id,
      efforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      defaultReasoningEffort: model.defaultReasoningEffort,
      hidden: model.hidden,
      inputModalities: model.inputModalities,
      upgrade: model.upgrade,
      upgradeInfo: model.upgradeInfo,
    })));
    const snapshot = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      protocolVersion: source === 'app-server-model-list' ? 2 : null,
      source,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + this.ttlMs).toISOString(),
      codexVersion: this.binaryVersion,
      provider: this.provider,
      scope,
      fingerprint,
      stale: false,
      models,
    };
    await this.#writeCache(snapshot);
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  async recordAvailability(combination, status, details = {}) {
    if (!['unknown', 'verified', 'temporarily_unavailable', 'denied'].includes(status)) {
      throw new Error(`Invalid model availability status: ${status}`);
    }
    const snapshot = structuredClone(this.lastSnapshot ?? await this.#readCache());
    if (!snapshot) throw new Error('No model catalog snapshot is available');
    const model = snapshot.models.find((entry) => entry.model === combination.model || entry.id === combination.model);
    if (!model) throw new Error(`Cannot record availability for unknown model: ${combination.model}`);
    model.availability = {
      status,
      checkedAt: this.now().toISOString(),
      provider: this.provider,
      identityHash: this.scope().identityHash,
      effort: combination.effort ?? null,
      reason: details.reason ?? null,
    };
    if (status === 'denied') {
      snapshot.expiresAt = null;
      snapshot.stale = true;
    }
    await this.#writeCache(snapshot);
    this.lastSnapshot = snapshot;
    return structuredClone(snapshot);
  }
}

export async function loadCodexCatalog(codexPath = 'codex', options = {}) {
  return new ModelRegistry({ codexPath, ...options }).discover({ refresh: options.refresh });
}

export function summarizeCatalog(catalog) {
  return catalogModels(catalog).map((raw) => {
    const model = raw.model ? raw : normalizeCatalogModel(raw);
    return {
      model: model.model,
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      defaultEffort: model.defaultReasoningEffort,
      efforts: normalizeEfforts(model).map((level) => level.reasoningEffort),
      hidden: model.hidden,
      inputModalities: model.inputModalities,
      availability: model.availability?.status ?? 'unknown',
    };
  });
}
