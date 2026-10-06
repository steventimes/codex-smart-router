import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SessionRouteState,
  applySwitchPolicy,
  buildCandidateSet,
  extractRouteDirective,
  routePrompt,
  selectManualCombination,
} from '../src/router.mjs';

const catalog = {
  fingerprint: 'catalog-1',
  models: [
    {
      id: 'strong-id', model: 'strong-model', displayName: 'Strong', description: 'Sourced strong profile.',
      hidden: false, isDefault: true, inputModalities: ['text', 'image'], defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'high', 'novel'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      availability: { status: 'verified' },
    },
    {
      id: 'efficient-id', model: 'efficient-model', displayName: 'Efficient', description: 'Sourced efficient profile.',
      hidden: false, isDefault: false, inputModalities: ['text'], defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      availability: { status: 'unknown' },
    },
    {
      id: 'denied-id', model: 'denied-model', displayName: 'Denied', description: '',
      hidden: false, isDefault: false, inputModalities: ['text'], defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }],
      availability: { status: 'denied' },
    },
  ],
};

const config = {
  maxCandidates: 6,
  modelProfiles: {
    'strong-model': { quality: 3, relativeCost: 3, source: 'test-profile' },
    'efficient-model': { quality: 1, relativeCost: 1, source: 'test-profile' },
  },
  automaticEfforts: ['low', 'high'],
  confidenceThreshold: 0.6,
};

function classifier(select) {
  return {
    async classify(input) {
      const selected = select(input);
      return {
        schemaVersion: 1,
        candidateId: selected,
        abstain: selected === null,
        confidence: selected === null ? 0.4 : 0.9,
        taskType: 'implementation',
        scope: 'focused',
        ambiguity: 'low',
        risk: 'low',
        verifiability: 'strong',
        reasonCodes: ['semantic_match'],
        classifier: { provider: 'test', model: 'test', latencyMs: 1, usage: null },
      };
    },
  };
}

test('builds bounded cross-model and cross-effort candidates without denied models', () => {
  const candidates = buildCandidateSet(catalog, { config });
  assert.ok(candidates.some((candidate) => candidate.model === 'strong-model' && candidate.effort === 'low'));
  assert.ok(candidates.some((candidate) => candidate.model === 'efficient-model' && candidate.effort === 'high'));
  assert.equal(candidates.some((candidate) => candidate.model === 'denied-model'), false);
  assert.ok(candidates.length <= 6);
  assert.ok(candidates.every((candidate) => /^candidate-[a-f0-9]{12}$/.test(candidate.id)));
});

test('filters a known text-only model for image input but retains a legal baseline', () => {
  const candidates = buildCandidateSet(catalog, { config, hasImages: true });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => candidate.model === 'strong-model'));
});

test('accepts a newly advertised effort explicitly and rejects an illegal combination', async () => {
  const decision = await routePrompt('::route model=strong-model effort=novel\nReview this', catalog, { config });
  assert.equal(decision.selected.model, 'strong-model');
  assert.equal(decision.selected.effort, 'novel');
  await assert.rejects(
    () => routePrompt('::route model=strong-model effort=imaginary\nReview this', catalog, { config }),
    /Legal efforts: low, high, novel/,
  );
});

test('does not execute a hidden catalog entry even through an explicit directive', async () => {
  const hiddenCatalog = structuredClone(catalog);
  hiddenCatalog.models.push({
    id: 'hidden-id', model: 'hidden-model', displayName: 'Hidden', description: '',
    hidden: true, isDefault: false, inputModalities: ['text'], defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }], availability: { status: 'unknown' },
  });
  await assert.rejects(
    () => routePrompt('::route model=hidden-model effort=low\nTry it', hiddenCatalog, { config }),
    /not selectable/i,
  );
});

test('classifier selects only an opaque candidate from the supplied set', async () => {
  let captured;
  const decision = await routePrompt('Implement the parser', catalog, {
    config,
    classifier: classifier((input) => {
      captured = input;
      return input.candidates.find((candidate) => candidate.model === 'efficient-model' && candidate.effort === 'high').id;
    }),
  });
  assert.equal(decision.selected.model, 'efficient-model');
  assert.equal(decision.selected.effort, 'high');
  assert.equal(decision.source, 'classifier');
  assert.equal(captured.candidates.length, buildCandidateSet(catalog, { config }).length);

  const invalid = await routePrompt('Implement it', catalog, {
    config,
    classifier: classifier(() => 'made-up'),
  });
  assert.equal(invalid.source, 'baseline');
  assert.equal(invalid.abstained, true);
  assert.match(invalid.warnings[0], /unknown candidate/i);
});

test('low confidence and incomplete context abstain to the legal user baseline', async () => {
  const baseline = { model: 'strong-model', effort: 'low' };
  const lowConfidence = await routePrompt('Do uncertain work', catalog, {
    config,
    baseline,
    classifier: classifier(() => null),
  });
  assert.equal(lowConfidence.abstained, true);
  assert.deepEqual(lowConfidence.selected, baseline);
  assert.equal(lowConfidence.source, 'baseline');

  const incomplete = await routePrompt('Continue', catalog, {
    config,
    baseline,
    context: { contextIncomplete: true },
    classifier: classifier((input) => input.candidates.at(-1).id),
  });
  assert.equal(incomplete.abstained, true);
  assert.deepEqual(incomplete.selected, baseline);
});

test('session pin, one-turn override, shadow, unpin, and off have defined precedence', async () => {
  const session = new SessionRouteState({ baseline: { model: 'strong-model', effort: 'low' } });
  await routePrompt('::route pin model=efficient-model effort=high\nPin it', catalog, { config, session });
  assert.deepEqual(session.pin, { model: 'efficient-model', effort: 'high' });

  const oneTurn = await routePrompt('::route model=strong-model effort=novel\nOne turn', catalog, { config, session });
  assert.deepEqual(oneTurn.selected, { model: 'strong-model', effort: 'novel' });
  assert.deepEqual(session.pin, { model: 'efficient-model', effort: 'high' });

  const pinned = await routePrompt('Use the session setting', catalog, { config, session });
  assert.deepEqual(pinned.selected, session.pin);
  assert.equal(pinned.source, 'session_pin');

  const shadow = await routePrompt('::route shadow\nSuggest only', catalog, {
    config,
    session,
    classifier: classifier((input) => input.candidates.find((candidate) => candidate.model === 'strong-model' && candidate.effort === 'high').id),
  });
  assert.equal(shadow.mode, 'shadow');
  assert.deepEqual(shadow.execution, session.baseline);
  assert.notDeepEqual(shadow.selected, shadow.execution);

  await routePrompt('::route unpin\nClear pin', catalog, {
    config,
    session,
    classifier: classifier((input) => input.candidates[0].id),
  });
  assert.equal(session.pin, null);

  const off = await routePrompt('::route off\nDo not route', catalog, { config, session });
  assert.equal(off.mode, 'off');
  assert.deepEqual(off.execution, session.baseline);
});

test('one-turn override wins session pin, which wins CLI pin and baseline', () => {
  assert.deepEqual(selectManualCombination({
    turnOverride: { model: 'turn', effort: 'high' },
    sessionPin: { model: 'session', effort: 'medium' },
    cliPin: { model: 'cli', effort: 'low' },
    baseline: { model: 'base', effort: 'low' },
  }), { source: 'turn_override', combination: { model: 'turn', effort: 'high' } });
  assert.equal(selectManualCombination({ sessionPin: { model: 'session', effort: 'medium' }, cliPin: { model: 'cli', effort: 'low' } }).source, 'session_pin');
});

test('cooldown and minimum gain prevent model thrashing', () => {
  const previous = { id: 'candidate-old', utility: 0.7 };
  assert.deepEqual(applySwitchPolicy({ id: 'candidate-new', utility: 0.75 }, {
    previousCandidate: previous,
    turnsSinceSwitch: 4,
  }, { minimumGain: 0.1, cooldownTurns: 2 }), previous);
  assert.deepEqual(applySwitchPolicy({ id: 'candidate-new', utility: 0.9 }, {
    previousCandidate: previous,
    turnsSinceSwitch: 1,
  }, { minimumGain: 0.1, cooldownTurns: 2 }), previous);
});

test('only a first-line user directive is treated as routing control', () => {
  assert.equal(extractRouteDirective('Please review:\n```\n::route off\n```').directive, null);
  assert.equal(extractRouteDirective(' ::route auto\nContinue').directive.mode, 'auto');
  assert.throws(() => extractRouteDirective('::route nonsense\nDo work'), /Invalid route directive/);
});
