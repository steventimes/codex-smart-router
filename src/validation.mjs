import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const VALID_STATUSES = new Set(['passed', 'failed', 'unknown', 'not_run']);
const FAILURE_TYPES = new Set([
  'logic', 'environment', 'permission', 'timeout', 'cancelled', 'model_unavailable', 'validator_tampered',
]);

export function createValidationResult({
  status = 'unknown',
  failureType = null,
  checkerId = null,
  protocolStatus = null,
  checkedAt = null,
  evidence = null,
} = {}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid validation status: ${status}`);
  if (failureType !== null && !FAILURE_TYPES.has(failureType)) throw new Error(`Invalid validation failure type: ${failureType}`);
  if (status !== 'failed') failureType = null;
  return {
    schemaVersion: 1,
    status,
    failureType,
    checkerId,
    protocolStatus,
    checkedAt: checkedAt ?? (status === 'unknown' || status === 'not_run' ? null : new Date().toISOString()),
    evidence,
    modelCapabilityEvidence: status === 'failed' && failureType === 'logic',
  };
}

export function evaluateCommandResult({
  exitCode,
  expectedExitCodes = [0],
  failureType = 'logic',
  checkerId = null,
  timedOut = false,
} = {}) {
  if (timedOut) return createValidationResult({ status: 'failed', failureType: 'timeout', checkerId });
  if (expectedExitCodes.includes(exitCode)) {
    return createValidationResult({ status: 'passed', checkerId, evidence: { exitCode } });
  }
  return createValidationResult({ status: 'failed', failureType, checkerId, evidence: { exitCode } });
}

export function shouldEscalateNextTurn({
  validation,
  escalationCount = 0,
  maxEscalations = 1,
  budgetRemaining = true,
  hasBetterCandidate = false,
} = {}) {
  if (validation?.status !== 'failed') return { escalate: false, stopReason: 'not_verified_failed' };
  if (validation.failureType !== 'logic') {
    return { escalate: false, stopReason: 'non_capability_failure' };
  }
  if (escalationCount >= maxEscalations) return { escalate: false, stopReason: 'max_escalations' };
  if (!budgetRemaining) return { escalate: false, stopReason: 'budget_exhausted' };
  if (!hasBetterCandidate) return { escalate: false, stopReason: 'no_better_legal_candidate' };
  return { escalate: true, stopReason: null };
}

async function fileHash(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function captureValidatorIntegrity(paths) {
  return {
    capturedAt: new Date().toISOString(),
    files: Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await fileHash(path)]))),
  };
}

export async function verifyValidatorIntegrity(snapshot) {
  const changed = [];
  const deleted = [];
  for (const [path, originalHash] of Object.entries(snapshot.files ?? {})) {
    const currentHash = await fileHash(path);
    if (currentHash === null) deleted.push(path);
    if (currentHash !== originalHash) changed.push(path);
  }
  return { ok: changed.length === 0, changed, deleted };
}
