import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureValidatorIntegrity,
  createValidationResult,
  evaluateCommandResult,
  shouldEscalateNextTurn,
  verifyValidatorIntegrity,
} from '../src/validation.mjs';

test('completed protocol status remains unknown without validation evidence', () => {
  const result = createValidationResult({ protocolStatus: 'completed' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.failureType, null);
});

test('maps configured validator results without treating environment failures as capability failures', () => {
  assert.equal(evaluateCommandResult({ exitCode: 0, expectedExitCodes: [0] }).status, 'passed');
  const logic = evaluateCommandResult({ exitCode: 1, expectedExitCodes: [0], failureType: 'logic' });
  assert.equal(logic.status, 'failed');
  assert.equal(logic.modelCapabilityEvidence, true);
  const environment = evaluateCommandResult({ exitCode: 127, expectedExitCodes: [0], failureType: 'environment' });
  assert.equal(environment.status, 'failed');
  assert.equal(environment.modelCapabilityEvidence, false);
});

test('escalates only verified logic failures within attempt and budget limits', () => {
  const failed = createValidationResult({ status: 'failed', failureType: 'logic', checkerId: 'tests' });
  assert.deepEqual(shouldEscalateNextTurn({
    validation: failed, escalationCount: 0, maxEscalations: 1, budgetRemaining: true, hasBetterCandidate: true,
  }), { escalate: true, stopReason: null });
  assert.equal(shouldEscalateNextTurn({
    validation: failed, escalationCount: 1, maxEscalations: 1, budgetRemaining: true, hasBetterCandidate: true,
  }).stopReason, 'max_escalations');
  assert.equal(shouldEscalateNextTurn({
    validation: { ...failed, failureType: 'environment' }, escalationCount: 0, maxEscalations: 1,
    budgetRemaining: true, hasBetterCandidate: true,
  }).stopReason, 'non_capability_failure');
  assert.equal(shouldEscalateNextTurn({
    validation: failed, escalationCount: 0, maxEscalations: 1, budgetRemaining: false, hasBetterCandidate: true,
  }).stopReason, 'budget_exhausted');
});

test('detects a modified or deleted validator instead of accepting its result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-validator-'));
  const validator = join(directory, 'verify.mjs');
  await writeFile(validator, 'process.exit(0);\n', 'utf8');
  const integrity = await captureValidatorIntegrity([validator]);
  await writeFile(validator, 'process.exit(1);\n', 'utf8');
  const changed = await verifyValidatorIntegrity(integrity);
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.changed, [validator]);
});
