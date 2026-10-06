import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const POLICY_SCHEMA_VERSION = 1;
export const POLICY_BUCKET_VERSION = 1;

function category(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

export function policyBucket(features = {}) {
  return [
    `taskType=${category(features.taskType)}`,
    `risk=${category(features.risk)}`,
    `verifiability=${category(features.verifiability)}`,
  ].join('|');
}

function combinationKey(model, effort) {
  return `${model}\0${effort}`;
}

function eligibleLabel(record) {
  if (record.validationStatus === 'passed') return true;
  if (record.validationStatus === 'failed' && record.failureType === 'logic') return false;
  return null;
}

function splitGroup(record) {
  const date = Number.isNaN(Date.parse(record.timestamp)) ? 'unknown-time' : String(record.timestamp).slice(0, 7);
  return `${category(record.repositoryHash)}\0${category(record.taskId)}\0${date}`;
}

function splitScore(group, seed) {
  const digest = createHash('sha256').update(`${seed}\0${group}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function splitPolicyRecords(records, { validationFraction = 0.2, seed = 'codex-smart-policy-v1' } = {}) {
  if (!Number.isFinite(validationFraction) || validationFraction < 0 || validationFraction >= 1) {
    throw new Error('validationFraction must be at least 0 and less than 1');
  }
  const train = [];
  const validation = [];
  for (const record of records) {
    const group = splitGroup(record);
    const target = splitScore(group, seed) < validationFraction ? validation : train;
    target.push({ ...record, splitGroup: group });
  }
  return { train, validation, seed, validationFraction };
}

function wilson(successes, failures, z = 1.96, alpha = 1, beta = 1) {
  const positive = successes + alpha;
  const total = successes + failures + alpha + beta;
  const rate = positive / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * total)) / total) / denominator;
  return { rate, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function finiteAverage(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function fitPolicy(records, options = {}) {
  const minimumSamples = options.minimumSamples ?? 3;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) throw new Error('minimumSamples must be a positive integer');
  const split = splitPolicyRecords(records, options);
  const eligible = split.train.filter((record) => (
    eligibleLabel(record) !== null && typeof record.model === 'string' && typeof record.effort === 'string'
  ));
  const buckets = {};
  for (const record of eligible) {
    const key = policyBucket(record);
    const combo = combinationKey(record.model, record.effort);
    buckets[key] ??= { features: {
      taskType: category(record.taskType), risk: category(record.risk), verifiability: category(record.verifiability),
    }, combinations: {} };
    const entry = buckets[key].combinations[combo] ??= {
      model: record.model, effort: record.effort, samples: 0, successes: 0, failures: 0,
      durationValues: [], tokenValues: [],
    };
    entry.samples += 1;
    if (eligibleLabel(record)) entry.successes += 1;
    else entry.failures += 1;
    entry.durationValues.push(record.durationMs);
    entry.tokenValues.push(record.usage?.totalTokens);
  }
  for (const bucket of Object.values(buckets)) {
    for (const entry of Object.values(bucket.combinations)) {
      const score = wilson(entry.successes, entry.failures);
      entry.smoothedRate = score.rate;
      entry.interval = { confidence: 0.95, lower: score.lower, upper: score.upper };
      entry.averageDurationMs = finiteAverage(entry.durationValues);
      entry.averageTotalTokens = finiteAverage(entry.tokenValues);
      delete entry.durationValues;
      delete entry.tokenValues;
    }
  }
  const catalogFingerprints = [...new Set(eligible.map((record) => record.catalogFingerprint).filter(Boolean))].sort();
  const deterministicCreatedAt = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    bucketVersion: POLICY_BUCKET_VERSION,
    createdAt: options.createdAt ?? (deterministicCreatedAt ? new Date(deterministicCreatedAt).toISOString() : null),
    catalogFingerprints,
    minimumSamples,
    method: {
      name: 'beta-smoothed-wilson', alpha: 1, beta: 1, confidence: 0.95,
      description: 'Beta(1,1)-smoothed empirical rate with a 95% Wilson interval; not a calibrated success probability.',
    },
    selectionBiasWarning: 'Only executed combinations are observed; unselected combinations have no counterfactual label.',
    split: { seed: split.seed, validationFraction: split.validationFraction, validationGroups: new Set(split.validation.map((row) => row.splitGroup)).size },
    training: { included: eligible.length, excluded: records.length - eligible.length },
    buckets,
  };
}

export async function loadPolicy(path) {
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  if (artifact.schemaVersion !== POLICY_SCHEMA_VERSION || artifact.bucketVersion !== POLICY_BUCKET_VERSION) {
    throw new Error('Unsupported policy artifact version');
  }
  if (!artifact.buckets || typeof artifact.buckets !== 'object') throw new Error('Policy artifact has no buckets');
  return artifact;
}

export function selectPolicyCandidate(policy, features, candidates, options = {}) {
  if (!policy) return null;
  if (policy.catalogFingerprints?.length > 0
    && !policy.catalogFingerprints.includes(options.catalogFingerprint)) return null;
  const bucket = policy.buckets?.[policyBucket(features)];
  if (!bucket) return null;
  const minimumSamples = options.minimumSamples ?? policy.minimumSamples ?? 3;
  const ranked = candidates.flatMap((candidate) => {
    const evidence = bucket.combinations?.[combinationKey(candidate.model, candidate.effort)];
    return evidence && evidence.samples >= minimumSamples ? [{ candidate, evidence }] : [];
  }).sort((left, right) => (
    right.evidence.interval.lower - left.evidence.interval.lower
    || right.evidence.smoothedRate - left.evidence.smoothedRate
    || (left.evidence.averageTotalTokens ?? Number.POSITIVE_INFINITY) - (right.evidence.averageTotalTokens ?? Number.POSITIVE_INFINITY)
    || left.candidate.id.localeCompare(right.candidate.id)
  ));
  return ranked[0] ?? null;
}

export function evaluatePolicy(policy, records) {
  let evaluated = 0;
  let matchedObservedCombination = 0;
  let validatedSuccesses = 0;
  for (const record of records) {
    const label = eligibleLabel(record);
    if (label === null) continue;
    const bucket = policy.buckets?.[policyBucket(record)];
    if (!bucket) continue;
    const candidates = Object.values(bucket.combinations).map((entry, index) => ({ ...entry, id: `policy-${index}` }));
    const selected = selectPolicyCandidate(policy, record, candidates, { catalogFingerprint: record.catalogFingerprint });
    if (!selected) continue;
    evaluated += 1;
    if (selected.candidate.model === record.model && selected.candidate.effort === record.effort) {
      matchedObservedCombination += 1;
      if (label) validatedSuccesses += 1;
    }
  }
  return {
    schemaVersion: 1,
    evaluated,
    matchedObservedCombination,
    observedSuccessesWhenMatched: validatedSuccesses,
    warning: policy.selectionBiasWarning,
  };
}
