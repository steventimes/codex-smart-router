import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScopeContext, compareScopeState } from '../src/scope-policy.mjs';

test('minimal scope is independent from terse output policy', () => {
  const context = buildScopeContext({ policy: 'minimal', allowedPaths: ['src/router.mjs'], terse: false });
  assert.equal(context.policy, 'minimal');
  assert.equal(context.terse, undefined);
  assert.match(context.text, /necessary files/i);
});

test('warns about new out-of-scope changes without reverting pre-existing dirty files', () => {
  const before = {
    files: {
      'existing.txt': { status: 'M', hash: 'before-user-change' },
      'src/router.mjs': { status: 'M', hash: 'old' },
    },
  };
  const after = {
    files: {
      'existing.txt': { status: 'M', hash: 'before-user-change' },
      'src/router.mjs': { status: 'M', hash: 'new' },
      'README.md': { status: 'M', hash: 'readme-change' },
    },
  };
  const report = compareScopeState(before, after, { allowedPaths: ['src/router.mjs'] });
  assert.deepEqual(report.preExistingDirty, ['existing.txt', 'src/router.mjs']);
  assert.deepEqual(report.changedByTask.sort(), ['README.md', 'src/router.mjs']);
  assert.deepEqual(report.outOfScope, ['README.md']);
  assert.equal(report.action, 'warn_only');
});

test('marks deleted validation files as tampering evidence', () => {
  const report = compareScopeState(
    { files: { 'test/check.test.mjs': { status: 'M', hash: 'validator' } } },
    { files: {} },
    { allowedPaths: ['src/'], validatorPaths: ['test/check.test.mjs'] },
  );
  assert.equal(report.validatorIntegrity, 'failed');
  assert.deepEqual(report.deletedValidators, ['test/check.test.mjs']);
});
