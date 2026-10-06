import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const AUDIT_FIELDS = new Set([
  'schemaVersion', 'event', 'eventId', 'timestamp', 'decisionId', 'routeId', 'taskId', 'threadId', 'turnId',
  'attemptId', 'catalogFingerprint', 'configFingerprint', 'routeSource', 'tier', 'model', 'effort', 'mode',
  'overridden', 'classifierConfidence', 'confidence', 'taskType', 'reasonCodes', 'constraints', 'exclusions',
  'classifier', 'protocolStatus', 'validationStatus', 'failureType', 'durationMs', 'usage', 'usageAttribution',
  'scopePolicy', 'scopeWarnings', 'synthetic', 'retryOf', 'escalationCount', 'stopReason', 'anonymousFeatures',
]);

export function defaultAuditPath(env = process.env) {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'smart-router', 'routes.jsonl');
}

function sanitizeUsage(usage) {
  if (usage === null || usage === undefined) return null;
  return Object.fromEntries(USAGE_FIELDS.map((field) => [
    field,
    Number.isFinite(usage[field]) ? usage[field] : null,
  ]));
}

function sanitizeClassifier(classifier) {
  if (!classifier) return null;
  return {
    provider: classifier.provider ?? null,
    destination: classifier.destination ?? null,
    protocol: classifier.protocol ?? null,
    model: classifier.model ?? null,
    latencyMs: Number.isFinite(classifier.latencyMs) ? classifier.latencyMs : null,
    usage: sanitizeUsage(classifier.usage),
    cacheHit: Boolean(classifier.cacheHit),
  };
}

function sanitizeAnonymousFeatures(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(['taskType', 'risk', 'verifiability', 'scope', 'ambiguity', 'repositoryHash', 'featureBucket']);
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (!allowed.has(key)) return [];
    if (typeof item === 'number' && Number.isFinite(item)) return [[key, item]];
    if (typeof item === 'boolean') return [[key, item]];
    if (typeof item === 'string' && /^[a-zA-Z0-9_.:=|/-]{1,160}$/.test(item)) return [[key, item]];
    return [];
  }));
}

export function redactAuditEntry(entry) {
  const record = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (!AUDIT_FIELDS.has(key)) continue;
    if (key === 'usage') record.usage = sanitizeUsage(value);
    else if (key === 'classifier') record.classifier = sanitizeClassifier(value);
    else if (key === 'reasonCodes' || key === 'constraints' || key === 'exclusions' || key === 'scopeWarnings') {
      record[key] = Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 32) : [];
    } else if (key === 'anonymousFeatures') {
      record[key] = sanitizeAnonymousFeatures(value);
    } else {
      record[key] = value;
    }
  }
  record.schemaVersion = 2;
  record.timestamp = entry.timestamp ?? new Date().toISOString();
  return record;
}

export async function appendAuditEvent(entry, path = defaultAuditPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record = redactAuditEntry(entry);
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export async function appendAudit(entry, path = defaultAuditPath()) {
  return appendAuditEvent({
    event: 'route',
    eventId: entry.eventId ?? entry.decisionId ?? entry.routeId,
    decisionId: entry.decisionId ?? entry.routeId,
    routeId: entry.routeId,
    taskId: entry.taskId,
    threadId: entry.threadId,
    catalogFingerprint: entry.catalogFingerprint,
    configFingerprint: entry.configFingerprint,
    routeSource: entry.source,
    tier: entry.tier,
    model: entry.execution?.model ?? entry.model,
    effort: entry.execution?.effort ?? entry.effort,
    mode: entry.mode,
    overridden: entry.overridden,
    classifierConfidence: entry.classifierConfidence ?? entry.confidence,
    confidence: entry.confidence,
    taskType: entry.taskType,
    reasonCodes: entry.reasonCodes,
    classifier: entry.classifier,
  }, path);
}

export async function appendUsageAudit(entry, path = defaultAuditPath()) {
  return appendAuditEvent({
    event: 'attempt',
    eventId: entry.eventId ?? [entry.attemptId, entry.turnId, 'attempt'].filter(Boolean).join(':'),
    decisionId: entry.decisionId ?? entry.routeId,
    routeId: entry.routeId,
    taskId: entry.taskId,
    threadId: entry.threadId,
    turnId: entry.turnId,
    attemptId: entry.attemptId,
    routeSource: entry.source,
    tier: entry.tier,
    model: entry.execution?.model ?? entry.model,
    effort: entry.execution?.effort ?? entry.effort,
    protocolStatus: entry.protocolStatus ?? entry.status,
    validationStatus: entry.validationStatus ?? 'unknown',
    failureType: entry.failureType,
    durationMs: entry.durationMs,
    usage: entry.usage,
    usageAttribution: entry.usageAttribution ?? 'known',
    retryOf: entry.retryOf,
    escalationCount: entry.escalationCount,
  }, path);
}

function emptyStats(path) {
  return {
    path,
    total: 0,
    tasks: 0,
    attempts: 0,
    tiers: {},
    models: {},
    efforts: {},
    modes: {},
    sources: {},
    averageScore: 0,
    averageConfidence: 0,
    classifiers: {},
    classifierUsage: { calls: 0, latencyMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    classifierUsageByModel: {},
    usage: { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverage: { known: 0, unknown: 0 } },
    usageByModel: {},
    validation: { passed: 0, failed: 0, unknown: 0, not_run: 0 },
    failureTypes: {},
    retries: 0,
    latency: { measured: 0, totalMs: 0 },
    daily: {},
    hourly: {},
    invalidRecords: 0,
    duplicateRecords: 0,
  };
}

function increment(result, key) {
  result[key ?? 'unknown'] = (result[key ?? 'unknown'] ?? 0) + 1;
}

function aggregateUsage(rows, rowUsage) {
  const result = { turns: rows.length, coverage: { known: 0, unknown: 0 } };
  const values = Object.fromEntries(USAGE_FIELDS.map((field) => [field, []]));
  for (const row of rows) {
    const usage = rowUsage(row);
    if (!usage) {
      result.coverage.unknown += 1;
      for (const field of USAGE_FIELDS) values[field].push(null);
      continue;
    }
    result.coverage.known += 1;
    for (const field of USAGE_FIELDS) values[field].push(Number.isFinite(usage[field]) ? usage[field] : null);
  }
  for (const field of USAGE_FIELDS) {
    result[field] = values[field].some((value) => value === null)
      ? (rows.length === 0 ? 0 : null)
      : values[field].reduce((sum, value) => sum + value, 0);
  }
  return result;
}

export async function readAuditStats(path = defaultAuditPath()) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyStats(path);
    throw error;
  }
  const stats = emptyStats(path);
  const rows = [];
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      stats.invalidRecords += 1;
    }
  }
  const unique = [];
  const eventIds = new Set();
  for (const row of rows) {
    if (row.eventId && eventIds.has(row.eventId)) {
      stats.duplicateRecords += 1;
      continue;
    }
    if (row.eventId) eventIds.add(row.eventId);
    unique.push(row);
  }
  const routes = unique.filter((row) => !row.event || row.event === 'route');
  const attempts = unique.filter((row) => row.event === 'usage' || row.event === 'attempt');
  const classifiedRoutes = routes.filter((row) => row.classifier);
  const validationEvents = unique.filter((row) => row.event === 'validation');
  const latestValidation = new Map();
  for (const row of validationEvents) latestValidation.set(row.attemptId ?? `${row.threadId}:${row.turnId}`, row);

  stats.total = routes.length;
  stats.attempts = attempts.length;
  stats.tasks = new Set([...routes, ...attempts].map((row) => row.taskId).filter(Boolean)).size;
  for (const row of routes) {
    increment(stats.tiers, row.tier);
    increment(stats.models, row.model);
    increment(stats.efforts, row.effort);
    increment(stats.modes, row.mode);
    increment(stats.sources, row.routeSource);
  }
  stats.averageScore = routes.length ? routes.reduce((sum, row) => sum + (row.score ?? 0), 0) / routes.length : 0;
  stats.averageConfidence = classifiedRoutes.length
    ? classifiedRoutes.reduce((sum, row) => sum + (row.classifierConfidence ?? row.confidence ?? 0), 0) / classifiedRoutes.length
    : 0;
  for (const row of classifiedRoutes) increment(stats.classifiers, `${row.classifier.provider}:${row.classifier.model}`);

  const classifierRows = classifiedRoutes.filter((row) => row.classifier?.usage);
  stats.classifierUsage = aggregateUsage(classifierRows, (row) => row.classifier.usage);
  stats.classifierUsage.calls = classifierRows.length;
  stats.classifierUsage.latencyMs = classifiedRoutes.reduce((sum, row) => sum + (row.classifier?.latencyMs ?? 0), 0);
  delete stats.classifierUsage.turns;
  delete stats.classifierUsage.coverage;
  for (const row of classifierRows) {
    const key = `${row.classifier.provider}:${row.classifier.model}`;
    const group = classifierRows.filter((item) => `${item.classifier.provider}:${item.classifier.model}` === key);
    stats.classifierUsageByModel[key] = { ...aggregateUsage(group, (item) => item.classifier.usage), calls: group.length };
    delete stats.classifierUsageByModel[key].turns;
    delete stats.classifierUsageByModel[key].coverage;
  }

  stats.usage = aggregateUsage(attempts, (row) => row.usage);
  for (const model of new Set(attempts.map((row) => row.model ?? 'unknown'))) {
    const group = attempts.filter((row) => (row.model ?? 'unknown') === model);
    stats.usageByModel[model] = aggregateUsage(group, (row) => row.usage);
  }
  for (const row of attempts) {
    const validation = latestValidation.get(row.attemptId ?? `${row.threadId}:${row.turnId}`);
    const status = validation?.validationStatus ?? row.validationStatus ?? 'unknown';
    increment(stats.validation, status);
    if (validation?.failureType ?? row.failureType) increment(stats.failureTypes, validation?.failureType ?? row.failureType);
    if (row.retryOf) stats.retries += 1;
    if (Number.isFinite(row.durationMs)) {
      stats.latency.measured += 1;
      stats.latency.totalMs += row.durationMs;
    }
    const date = row.timestamp?.slice(0, 10) ?? 'unknown';
    stats.daily[date] ??= { turns: 0, totalTokens: 0, durationMs: 0 };
    stats.daily[date].turns += 1;
    if (Number.isFinite(row.usage?.totalTokens)) stats.daily[date].totalTokens += row.usage.totalTokens;
    stats.daily[date].durationMs += row.durationMs ?? 0;
    const parsed = row.timestamp ? new Date(row.timestamp) : null;
    const bucket = parsed && !Number.isNaN(parsed.getTime())
      ? new Date(Math.floor(parsed.getTime() / 3_600_000) * 3_600_000).toISOString()
      : 'unknown';
    stats.hourly[bucket] ??= { turns: 0, totalTokens: 0, durationMs: 0 };
    stats.hourly[bucket].turns += 1;
    if (Number.isFinite(row.usage?.totalTokens)) stats.hourly[bucket].totalTokens += row.usage.totalTokens;
    stats.hourly[bucket].durationMs += row.durationMs ?? 0;
  }
  return stats;
}

async function readAuditRows(path) {
  const content = await readFile(path, 'utf8');
  return content.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export async function exportAnonymousAudit(sourcePath = defaultAuditPath(), outputPath) {
  if (!outputPath) throw new Error('Anonymous export requires an explicit output path');
  const rows = await readAuditRows(sourcePath);
  const routes = new Map(rows.filter((row) => !row.event || row.event === 'route').map((row) => [row.decisionId ?? row.routeId, row]));
  const validation = new Map(rows.filter((row) => row.event === 'validation').map((row) => [row.attemptId ?? `${row.threadId}:${row.turnId}`, row]));
  const records = rows.filter((row) => row.event === 'attempt' || row.event === 'usage').map((row) => {
    const route = routes.get(row.decisionId ?? row.routeId) ?? {};
    const result = validation.get(row.attemptId ?? `${row.threadId}:${row.turnId}`) ?? row;
    return {
      schemaVersion: 1,
      taskId: row.taskId ?? null,
      repositoryHash: route.anonymousFeatures?.repositoryHash ?? 'unknown',
      timestamp: row.timestamp ?? null,
      taskType: route.taskType ?? route.anonymousFeatures?.taskType ?? 'unknown',
      risk: route.anonymousFeatures?.risk ?? 'unknown',
      verifiability: route.anonymousFeatures?.verifiability ?? 'unknown',
      model: row.model ?? null,
      effort: row.effort ?? null,
      validationStatus: result.validationStatus ?? row.validationStatus ?? 'unknown',
      failureType: result.failureType ?? row.failureType ?? null,
      durationMs: Number.isFinite(row.durationMs) ? row.durationMs : null,
      usage: sanitizeUsage(row.usage),
      catalogFingerprint: route.catalogFingerprint ?? null,
    };
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  return { sourcePath, outputPath, records: records.length };
}

export async function pruneAudit(path = defaultAuditPath(), { before, keepDays, now = new Date() } = {}) {
  let cutoff;
  if (before) cutoff = new Date(before);
  else if (Number.isFinite(keepDays) && keepDays >= 0) cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  else throw new Error('Prune requires before or a non-negative keepDays value');
  if (Number.isNaN(cutoff.getTime())) throw new Error('Invalid audit prune cutoff');
  const content = await readFile(path, 'utf8');
  let removed = 0;
  const kept = content.split('\n').filter(Boolean).filter((line) => {
    try {
      const row = JSON.parse(line);
      const timestamp = Date.parse(row.timestamp);
      if (Number.isFinite(timestamp) && timestamp < cutoff.getTime()) {
        removed += 1;
        return false;
      }
    } catch {
      // Preserve malformed historical lines; pruning must not silently destroy unparsed data.
    }
    return true;
  });
  const temporary = `${path}.${process.pid}.prune.tmp`;
  await writeFile(temporary, kept.join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
  await rename(temporary, path);
  return { path, cutoff: cutoff.toISOString(), removed, retained: kept.length };
}
