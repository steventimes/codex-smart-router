import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTaskFeatures, summarizeRepository } from '../src/task-context.mjs';

test('builds versioned features with bounded history and explicit incomplete context', () => {
  const features = buildTaskFeatures({
    prompt: 'Continue',
    history: Array.from({ length: 12 }, (_, index) => `history-${index}`),
    hasImages: true,
    context: { contextIncomplete: true, previousStatus: 'failed', previousDecision: { decisionId: 'prior' } },
  });
  assert.equal(features.schemaVersion, 1);
  assert.equal(features.history.length, 6);
  assert.equal(features.hasImages, true);
  assert.equal(features.contextIncomplete, true);
  assert.equal(features.previous.status, 'failed');
});

test('repository summary is metadata-only and bounded by file and byte limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-summary-'));
  await writeFile(join(directory, 'alpha.txt'), 'TOP_SECRET_VALUE', 'utf8');
  await writeFile(join(directory, 'beta.txt'), 'other content', 'utf8');
  const summary = await summarizeRepository(directory, { maxFiles: 1, maxBytes: 100, timeoutMs: 1_000 });
  assert.equal(summary.files.length, 1);
  assert.equal(summary.truncated, true);
  assert.doesNotMatch(JSON.stringify(summary), /TOP_SECRET_VALUE/);
});
