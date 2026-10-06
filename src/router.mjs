import { createHash, randomUUID } from 'node:crypto';
import { normalizeCatalogModel, validateCombination } from './catalog.mjs';
import { selectPolicyCandidate } from './policy.mjs';
import { buildTaskFeatures } from './task-context.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  configVersion: 2,
  maxCandidates: 8,
  confidenceThreshold: 0.6,
  automaticEfforts: ['low', 'medium', 'high', 'xhigh'],
  automaticHighModes: [],
  modelProfiles: {},
  allowlist: null,
  minimumSwitchGain: 0.1,
  switchCooldownTurns: 2,
  tiers: {},
});

function normalizedModels(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models) || models.length === 0) throw new Error('Codex model catalog is empty');
  return models.map((model) => model.model ? model : normalizeCatalogModel(model));
}

function effortNames(model) {
  return (model.supportedReasoningEfforts ?? model.supported_reasoning_levels ?? [])
    .map((entry) => typeof entry === 'string' ? entry : (entry.reasoningEffort ?? entry.effort))
    .filter((effort) => typeof effort === 'string' && effort.length > 0);
}

function candidateId(model, effort) {
  const digest = createHash('sha256').update(`${model}\0${effort}`).digest('hex').slice(0, 12);
  return `candidate-${digest}`;
}

function addCandidate(target, seen, model, effort, profile) {
  const key = `${model.model}\0${effort}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    id: candidateId(model.model, effort),
    model: model.model,
    catalogId: model.id,
    effort,
    displayName: model.displayName,
    description: model.description,
    availability: model.availability?.status ?? 'unknown',
    profile: profile ?? null,
  });
}

export function buildCandidateSet(catalog, options = {}) {
  const config = mergeConfig(options.config);
  const allowlist = options.allowlist ?? config.allowlist;
  const requiredCapabilities = new Set(options.requiredCapabilities ?? []);
  const models = normalizedModels(catalog).filter((model) => {
    if (model.hidden) return false;
    if (model.availability?.status === 'denied') return false;
    if (allowlist && !allowlist.includes(model.model) && !allowlist.includes(model.id)) return false;
    if (options.hasImages && Array.isArray(model.inputModalities) && !model.inputModalities.includes('image')) return false;
    if (requiredCapabilities.size > 0) {
      const known = new Set(model.capabilities ?? []);
      if ([...requiredCapabilities].some((capability) => !known.has(capability))) {
        return Boolean(options.baseline && options.baseline.model === model.model);
      }
    }
    return true;
  });
  if (models.length === 0) return [];

  const automaticEfforts = new Set(config.automaticEfforts);
  const highModes = new Set(config.automaticHighModes);
  const allowedEfforts = (model) => {
    const advertised = effortNames(model);
    return advertised.filter((effort) => {
      if (effort === model.defaultReasoningEffort) return true;
      if (effort === 'max' || effort === 'ultra') return highModes.has(effort);
      return automaticEfforts.has(effort);
    });
  };
  const candidates = [];
  const seen = new Set();

  for (const model of models) {
    const efforts = allowedEfforts(model);
    const preferred = efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0];
    if (preferred) addCandidate(candidates, seen, model, preferred, config.modelProfiles[model.model]);
  }

  const profiled = models.filter((model) => config.modelProfiles[model.model]);
  const strongest = [...profiled].sort((a, b) => (
    config.modelProfiles[b.model].quality - config.modelProfiles[a.model].quality
  ))[0];
  const efficient = [...profiled].sort((a, b) => (
    config.modelProfiles[a.model].relativeCost - config.modelProfiles[b.model].relativeCost
  ))[0];
  if (strongest) {
    const efforts = allowedEfforts(strongest);
    if (efforts[0]) addCandidate(candidates, seen, strongest, efforts[0], config.modelProfiles[strongest.model]);
  }
  if (efficient) {
    const efforts = allowedEfforts(efficient);
    if (efforts.at(-1)) addCandidate(candidates, seen, efficient, efforts.at(-1), config.modelProfiles[efficient.model]);
  }

  for (const model of models) {
    for (const effort of allowedEfforts(model)) {
      addCandidate(candidates, seen, model, effort, config.modelProfiles[model.model]);
    }
  }
  return candidates.slice(0, config.maxCandidates);
}

export class SessionRouteState {
  constructor({ mode = 'auto', baseline = null, cliPin = null } = {}) {
    this.mode = mode;
    this.baseline = baseline;
    this.cliPin = cliPin;
    this.pin = null;
    this.lastAutomatic = null;
    this.previousCandidate = null;
    this.turnsSinceSwitch = Number.POSITIVE_INFINITY;
  }

  setMode(mode) {
    if (!['auto', 'shadow', 'off'].includes(mode)) throw new Error(`Invalid routing mode: ${mode}`);
    this.mode = mode;
  }

  setPin(combination) {
    this.pin = combination;
  }

  unpin() {
    this.pin = null;
  }
}

export function extractRouteDirective(prompt) {
  const source = String(prompt ?? '');
  const match = source.match(/^\s*::route\s+([^\r\n]+)(?:\r?\n|$)/i);
  if (!match) return { prompt: source, directive: null };
  const value = match[1].trim();
  const normalized = value.toLowerCase();
  const tierAliases = {
    cheap: 'economy', economy: 'economy', normal: 'balanced', balanced: 'balanced',
    complex: 'complex', deep: 'frontier', frontier: 'frontier', max: 'max',
  };
  let directive;
  if (['auto', 'shadow', 'off'].includes(normalized)) {
    directive = { type: 'mode', mode: normalized };
  } else if (normalized === 'unpin') {
    directive = { type: 'unpin' };
  } else if (tierAliases[normalized]) {
    directive = { type: 'tier', tier: tierAliases[normalized] };
  } else {
    const pin = value.match(/^pin\s+model=([^\s]+)\s+effort=([^\s]+)$/i);
    const custom = value.match(/^model=([^\s]+)\s+effort=([^\s]+)$/i);
    if (pin) directive = { type: 'pin', model: pin[1], effort: pin[2] };
    else if (custom) directive = { type: 'custom', model: custom[1], effort: custom[2] };
    else throw new Error(`Invalid route directive: ${value}`);
  }
  return { prompt: source.slice(match[0].length), directive };
}

export function selectManualCombination({ turnOverride, sessionPin, cliPin, baseline }) {
  if (turnOverride) return { source: 'turn_override', combination: turnOverride };
  if (sessionPin) return { source: 'session_pin', combination: sessionPin };
  if (cliPin) return { source: 'cli_pin', combination: cliPin };
  if (baseline) return { source: 'baseline', combination: baseline };
  return { source: null, combination: null };
}

export function applySwitchPolicy(recommendation, state, options = {}) {
  const previous = state?.previousCandidate;
  if (!previous || !recommendation) return recommendation ?? previous ?? null;
  const minimumGain = options.minimumGain ?? DEFAULT_CONFIG.minimumSwitchGain;
  const cooldownTurns = options.cooldownTurns ?? DEFAULT_CONFIG.switchCooldownTurns;
  if ((state.turnsSinceSwitch ?? Number.POSITIVE_INFINITY) < cooldownTurns) return previous;
  if (Number.isFinite(previous.utility) && Number.isFinite(recommendation.utility)
    && recommendation.utility - previous.utility < minimumGain) return previous;
  return recommendation;
}

function baselineFor(catalog, provided) {
  if (provided) return validateCombination(catalog, provided);
  const model = normalizedModels(catalog).find((entry) => entry.isDefault && !entry.hidden);
  if (!model || !model.defaultReasoningEffort) return null;
  return validateCombination(catalog, { model: model.model, effort: model.defaultReasoningEffort });
}

export function resolveTier(tier, catalog, config = DEFAULT_CONFIG) {
  const merged = mergeConfig(config);
  const models = normalizedModels(catalog).filter((model) => !model.hidden && model.availability?.status !== 'denied');
  const configured = merged.tiers[tier];
  if (configured?.candidates) {
    for (const candidateModel of configured.candidates) {
      const model = models.find((entry) => entry.model === candidateModel || entry.id === candidateModel);
      if (!model) continue;
      const desired = configured.effort ?? model.defaultReasoningEffort;
      if (effortNames(model).includes(desired)) return { model: model.model, effort: desired };
    }
  }
  const ranked = models.filter((model) => merged.modelProfiles[model.model]);
  const byCost = [...ranked].sort((a, b) => merged.modelProfiles[a.model].relativeCost - merged.modelProfiles[b.model].relativeCost);
  const byQuality = [...ranked].sort((a, b) => merged.modelProfiles[b.model].quality - merged.modelProfiles[a.model].quality);
  const defaultModel = models.find((model) => model.isDefault);
  const model = tier === 'economy' ? byCost[0]
    : tier === 'balanced' ? defaultModel
      : byQuality[0];
  if (!model) throw new Error(`No sourced model profile or catalog default can satisfy tier ${tier}`);
  const efforts = effortNames(model);
  let effort = model.defaultReasoningEffort;
  if (tier === 'frontier') effort = ['xhigh', 'high', effort].find((value) => efforts.includes(value));
  if (tier === 'max') effort = ['max', 'xhigh', 'high', effort].find((value) => efforts.includes(value));
  return validateCombination(catalog, { model: model.model, effort });
}

function makeDecision({ prompt, mode, selected, execution, source, baseline, classification = null, policyEvidence = null, warnings = [], overridden = false }) {
  return {
    schemaVersion: 1,
    decisionId: randomUUID(),
    taskId: null,
    mode,
    selected,
    execution,
    candidateId: classification?.candidateId ?? null,
    abstained: source === 'baseline' || Boolean(classification?.abstain),
    source,
    classifierConfidence: classification?.confidence ?? null,
    statisticalEvidenceCount: policyEvidence?.samples ?? 0,
    taskType: classification?.taskType ?? (overridden ? 'explicit_override' : 'unknown'),
    features: classification ? {
      scope: classification.scope,
      ambiguity: classification.ambiguity,
      risk: classification.risk,
      verifiability: classification.verifiability,
    } : null,
    reasonCodes: classification?.reasonCodes ?? (overridden ? ['explicit_override'] : ['baseline']),
    constraints: [],
    exclusions: [],
    baseline,
    classifier: classification?.classifier ?? null,
    warnings,
    prompt,
    overridden,
  };
}

export async function routePrompt(prompt, catalog, options = {}) {
  const config = mergeConfig(options.config);
  const session = options.session ?? new SessionRouteState({ baseline: options.baseline, cliPin: options.cliPin });
  const extracted = options.directive
    ? { prompt: String(prompt ?? ''), directive: options.directive }
    : extractRouteDirective(prompt);
  const directive = extracted.directive;
  if (directive?.type === 'mode' && directive.mode === 'off') {
    session.setMode('off');
    const unverifiedBaseline = options.baseline ?? session.baseline;
    if (!unverifiedBaseline) throw new Error('Routing is off but no user baseline is known');
    return makeDecision({
      prompt: extracted.prompt,
      mode: 'off',
      selected: unverifiedBaseline,
      execution: unverifiedBaseline,
      source: 'baseline',
      baseline: unverifiedBaseline,
      warnings: ['Routing disabled; the App Server retains responsibility for validating the existing baseline.'],
      overridden: true,
    });
  }
  const baseline = baselineFor(catalog, options.baseline ?? session.baseline);
  if (baseline && !session.baseline) session.baseline = baseline;

  if (directive?.type === 'mode') session.setMode(directive.mode);
  if (directive?.type === 'unpin') session.unpin();
  if (directive?.type === 'pin') {
    const pin = validateCombination(catalog, { model: directive.model, effort: directive.effort });
    session.setPin(pin);
  }
  const turnOverride = directive?.type === 'custom'
    ? validateCombination(catalog, { model: directive.model, effort: directive.effort })
    : directive?.type === 'tier' ? resolveTier(directive.tier, catalog, config) : null;

  if (session.mode === 'off') {
    if (!baseline) throw new Error('Routing is off but no legal user baseline is known');
    return makeDecision({
      prompt: extracted.prompt, mode: 'off', selected: baseline, execution: baseline,
      source: 'baseline', baseline, overridden: Boolean(directive),
    });
  }

  const manual = selectManualCombination({
    turnOverride,
    sessionPin: session.pin,
    cliPin: session.cliPin ?? options.cliPin,
    baseline,
  });
  if (turnOverride || session.pin || session.cliPin || options.cliPin || directive?.type === 'pin') {
    const selected = validateCombination(catalog, manual.combination);
    return makeDecision({
      prompt: extracted.prompt,
      mode: session.mode,
      selected,
      execution: session.mode === 'shadow' ? baseline : selected,
      source: manual.source,
      baseline,
      overridden: true,
    });
  }

  if (!baseline) throw new Error('No legal user baseline is available for automatic routing');
  if (!options.classifier) {
    return makeDecision({
      prompt: extracted.prompt, mode: session.mode, selected: baseline, execution: baseline,
      source: 'baseline', baseline, warnings: ['No classifier is configured; kept the legal baseline.'],
    });
  }
  const candidates = buildCandidateSet(catalog, {
    config,
    hasImages: options.hasImages,
    requiredCapabilities: options.requiredCapabilities,
    baseline,
  });
  if (candidates.length === 0) throw new Error('No legal model and reasoning-effort candidates are available');
  const taskFeatures = buildTaskFeatures({
    prompt: extracted.prompt,
    history: options.history ?? [],
    hasImages: options.hasImages,
    context: options.context,
    repositorySummary: options.repositorySummary,
  });

  let classification;
  try {
    classification = await options.classifier.classify({ ...taskFeatures, candidates, baseline });
    const selectedCandidate = candidates.find((candidate) => candidate.id === classification.candidateId);
    const mustAbstain = classification.abstain
      || classification.confidence < config.confidenceThreshold
      || taskFeatures.contextIncomplete
      || classification.risk === 'high';
    if (!classification.abstain && !selectedCandidate) {
      throw new Error(`Classifier returned an unknown candidate: ${classification.candidateId}`);
    }
    if (mustAbstain) {
      return makeDecision({
        prompt: extracted.prompt, mode: session.mode, selected: baseline,
        execution: baseline, source: 'baseline', baseline, classification,
      });
    }
    const selected = validateCombination(catalog, selectedCandidate);
    const policySelection = selectPolicyCandidate(options.policy, classification, candidates, {
      catalogFingerprint: catalog.fingerprint,
    });
    const policySelected = policySelection ? validateCombination(catalog, policySelection.candidate) : selected;
    session.lastAutomatic = policySelected;
    return makeDecision({
      prompt: extracted.prompt, mode: session.mode, selected: policySelected,
      execution: session.mode === 'shadow' ? baseline : policySelected,
      source: policySelection ? 'policy' : 'classifier', baseline, classification,
      policyEvidence: policySelection?.evidence, overridden: Boolean(directive),
    });
  } catch (error) {
    return makeDecision({
      prompt: extracted.prompt, mode: session.mode, selected: baseline, execution: baseline,
      source: 'baseline', baseline, classification, warnings: [error.message],
    });
  }
}

export function mergeConfig(overrides = {}) {
  overrides ??= {};
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    modelProfiles: { ...DEFAULT_CONFIG.modelProfiles, ...(overrides.modelProfiles ?? {}) },
    tiers: { ...DEFAULT_CONFIG.tiers, ...(overrides.tiers ?? {}) },
  };
}
