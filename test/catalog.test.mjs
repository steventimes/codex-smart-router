import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ModelRegistry,
  normalizeCatalogModel,
  summarizeCatalog,
  validateCombination,
} from '../src/catalog.mjs';
import { buildDoctorReport } from '../src/doctor.mjs';

const CURRENT_MODEL = {
  id: 'future-id',
  model: 'future-model',
  displayName: 'Future Model',
  description: 'A model unknown to this router version.',
  supportedReasoningEfforts: [
    { reasoningEffort: 'feather', description: 'New effort.' },
    { reasoningEffort: 'deep-space', description: 'Another new effort.' },
  ],
  defaultReasoningEffort: 'feather',
  hidden: false,
  isDefault: true,
  inputModalities: ['text', 'image'],
  upgrade: null,
  upgradeInfo: null,
};

test('normalizes current and legacy catalog fields without inventing a closed effort enum', () => {
  const current = normalizeCatalogModel(CURRENT_MODEL, {
    source: 'app-server-model-list',
    defaultModalities: ['text', 'image'],
  });
  const legacy = normalizeCatalogModel({
    slug: 'legacy-slug',
    display_name: 'Legacy',
    description: 'Old shape.',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'wild-new' }],
    default_reasoning_level: 'wild-new',
    visibility: 'list',
  }, { source: 'codex-debug-models' });

  assert.equal(current.model, 'future-model');
  assert.equal(current.id, 'future-id');
  assert.deepEqual(current.supportedReasoningEfforts.map((item) => item.reasoningEffort), ['feather', 'deep-space']);
  assert.deepEqual(legacy.supportedReasoningEfforts.map((item) => item.reasoningEffort), ['low', 'wild-new']);
  assert.equal(legacy.inputModalities, null);
  assert.equal(legacy.modalityEvidence, 'unknown');
});

test('uses verified protocol defaults when model/list omits modalities', () => {
  const model = normalizeCatalogModel({ ...CURRENT_MODEL, inputModalities: undefined }, {
    source: 'app-server-model-list',
    defaultModalities: ['text', 'image'],
  });
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.equal(model.modalityEvidence, 'protocol-default');
});

test('validates only advertised combinations and lists legal values on error', () => {
  const catalog = { models: [normalizeCatalogModel(CURRENT_MODEL)] };
  assert.deepEqual(validateCombination(catalog, { model: 'future-model', effort: 'deep-space' }), {
    model: 'future-model',
    effort: 'deep-space',
  });
  assert.throws(
    () => validateCombination(catalog, { model: 'future-model', effort: 'low' }),
    /Legal efforts: feather, deep-space/,
  );
  assert.throws(
    () => validateCombination({ models: [{ ...catalog.models[0], supportedReasoningEfforts: [] }] }, { model: 'future-model', effort: 'low' }),
    /does not advertise any selectable reasoning efforts/,
  );
});

test('registry coalesces refresh, persists atomically, and isolates identity scope', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'codex-smart-catalog-'));
  let calls = 0;
  const createRegistry = (identity) => new ModelRegistry({
    cacheDirectory,
    identityScope: identity,
    provider: 'openai',
    binaryVersion: '0.160.1',
    now: () => new Date('2026-10-06T12:00:00.000Z'),
    clientFactory: async () => ({
      async listModels() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [CURRENT_MODEL];
      },
      async close() {},
    }),
  });
  const firstRegistry = createRegistry('account-a');

  const [first, duplicate] = await Promise.all([
    firstRegistry.discover({ refresh: true }),
    firstRegistry.discover({ refresh: true }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.fingerprint, duplicate.fingerprint);
  assert.equal(first.models[0].availability.status, 'unknown');

  const cached = await createRegistry('account-a').discover();
  assert.equal(calls, 1);
  assert.equal(cached.stale, false);
  await createRegistry('account-b').discover();
  assert.equal(calls, 2);
  assert.notEqual(first.scope.identityHash, (await createRegistry('account-b').discover()).scope.identityHash);
});

test('registry ignores corrupt cache and denied evidence invalidates the snapshot', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'codex-smart-catalog-corrupt-'));
  let calls = 0;
  const registry = new ModelRegistry({
    cacheDirectory,
    identityScope: 'account-a',
    provider: 'openai',
    binaryVersion: '0.160.1',
    clientFactory: async () => ({
      async listModels() { calls += 1; return [CURRENT_MODEL]; },
      async close() {},
    }),
  });
  const cachePath = registry.cachePath();
  await writeFile(cachePath, '{broken', 'utf8');
  const snapshot = await registry.discover();
  assert.equal(calls, 1);

  await registry.recordAvailability({ model: 'future-model', effort: 'feather' }, 'denied');
  const stored = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(stored.models[0].availability.status, 'denied');
  assert.equal(stored.expiresAt, null);
  assert.equal(snapshot.models[0].availability.status, 'unknown');
});

test('rejects an empty runtime directory and reports source/evidence in doctor output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-empty-'));
  const registry = new ModelRegistry({
    cacheDirectory: directory,
    identityScope: 'account-a',
    provider: 'openai',
    binaryVersion: '0.160.1',
    clientFactory: async () => ({ async listModels() { return []; }, async close() {} }),
  });
  await assert.rejects(() => registry.discover({ refresh: true }), /no selectable models/i);

  const report = buildDoctorReport({
    binary: { path: 'codex', version: '0.160.1', appServerTransport: 'stdio://' },
    catalog: {
      source: 'app-server-model-list',
      stale: false,
      models: [normalizeCatalogModel(CURRENT_MODEL)],
      scope: { identityHash: 'abc', provider: 'openai' },
    },
    classifier: { backend: 'codex', billing: 'subscription' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.catalog.legalCombinations, 2);
  assert.equal(report.catalog.source, 'app-server-model-list');
  assert.deepEqual(summarizeCatalog({ models: [normalizeCatalogModel(CURRENT_MODEL)] })[0].efforts, ['feather', 'deep-space']);
});
