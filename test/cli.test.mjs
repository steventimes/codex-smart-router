import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportAnonymousAudit, pruneAudit } from '../src/audit.mjs';
import { isCliEntryPoint, main, parseArgs } from '../bin/codex-smart.mjs';
import { previewConfigMigration } from '../src/config-migration.mjs';

test('parses operational commands and explicit routing controls', () => {
  assert.equal(parseArgs(['models', '--refresh', '--json']).command, 'models');
  const launch = parseArgs(['--mode', 'shadow', '--scope', 'minimal', '--model', 'm', '--effort', 'high']);
  assert.equal(launch.mode, 'shadow');
  assert.equal(launch.scopePolicy, 'minimal');
  assert.deepEqual(launch.cliPin, { model: 'm', effort: 'high' });
  assert.throws(() => parseArgs(['benchmark', 'run', '--live']), /budget/i);
});

test('benchmark JSON stdout is parseable and contains no progress text', async () => {
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: { write: (chunk) => stdout.push(String(chunk)) },
    stderr: { write: (chunk) => stderr.push(String(chunk)) },
  };
  assert.equal(await main(['benchmark', 'run', '--json'], io), 0);
  assert.equal(JSON.parse(stdout.join('')).measurement, 'synthetic');
  assert.deepEqual(stderr, []);
});

test('anonymous export and retention prune secrets and old records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-cli-'));
  const source = join(directory, 'routes.jsonl');
  const output = join(directory, 'anonymous.jsonl');
  await writeFile(source, [
    JSON.stringify({ schemaVersion: 2, event: 'attempt', eventId: 'old', timestamp: '2020-01-01T00:00:00Z', taskId: 't', model: 'm', effort: 'low', validationStatus: 'passed', apiKey: 'sk-secret', prompt: 'PRIVATE' }),
    JSON.stringify({ schemaVersion: 2, event: 'attempt', eventId: 'new', timestamp: '2026-10-01T00:00:00Z', taskId: 't2', model: 'm', effort: 'high', validationStatus: 'failed', failureType: 'logic' }),
  ].join('\n'));
  const exported = await exportAnonymousAudit(source, output);
  assert.equal(exported.records, 2);
  assert.doesNotMatch(await readFile(output, 'utf8'), /sk-secret|PRIVATE/);
  const result = await pruneAudit(source, { before: '2026-01-01T00:00:00Z' });
  assert.equal(result.removed, 1);
  assert.doesNotMatch(await readFile(source, 'utf8'), /"old"/);
});

test('legacy config migration is preview-only unless an output write is explicit', () => {
  const preview = previewConfigMigration({ tiers: { economy: { candidates: ['old'], effort: 'low' } } });
  assert.equal(preview.fromVersion, 1);
  assert.equal(preview.config.configVersion, 2);
  assert.deepEqual(preview.config.tiers.economy.candidates, ['old']);
  assert.throws(() => parseArgs(['migrate', '--input', 'old.json']), /preview or --write/);
});

test('recognizes the packaged npm bin symlink as the CLI entry point', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-bin-'));
  const link = join(directory, 'codex-smart');
  await symlink(new URL('../bin/codex-smart.mjs', import.meta.url), link);
  assert.equal(isCliEntryPoint(link), true);
});
