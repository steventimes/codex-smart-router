import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PRICING_PATH = fileURLToPath(new URL('../assets/pricing.json', import.meta.url));
export const DEFAULT_PRICING = Object.freeze(JSON.parse(await readFile(PRICING_PATH, 'utf8')));

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

export function calculateUsageCost(usage, price) {
  if (!usage || !price) return null;
  const input = finite(usage.inputTokens);
  const cached = finite(usage.cachedInputTokens);
  const output = finite(usage.outputTokens);
  if (input === null || cached === null || output === null || cached > input) return null;
  if (![price.inputPerMillion, price.outputPerMillion].every(Number.isFinite)) return null;
  const cachedRate = Number.isFinite(price.cachedInputPerMillion) ? price.cachedInputPerMillion : price.inputPerMillion;
  // cachedInputTokens is a subdivision of inputTokens; reasoningOutputTokens is a subdivision of outputTokens.
  return (((input - cached) * price.inputPerMillion) + (cached * cachedRate) + (output * price.outputPerMillion)) / 1_000_000;
}

export function parsePricing(value) {
  if (!value) return structuredClone(DEFAULT_PRICING);
  const parsed = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
  if (parsed.schemaVersion === 1 && parsed.models && typeof parsed.models === 'object') return parsed;
  return {
    schemaVersion: 1, currency: 'USD', source: 'legacy user configuration',
    effectiveDate: null, serviceTier: 'unspecified', models: parsed,
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

export function buildDashboard(stats, options = {}) {
  const pricing = parsePricing(options.pricing);
  const billingMode = options.billingMode ?? 'subscription';
  const missingModels = [];
  let knownSubtotal = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  for (const [model, usage] of Object.entries(stats.usageByModel ?? {})) {
    const amount = calculateUsageCost(usage, pricing.models[model]);
    if (amount === null) {
      missingModels.push(model);
      unpricedTurns += usage.turns ?? 0;
    } else {
      knownSubtotal += amount;
      pricedTurns += usage.turns ?? 0;
    }
  }
  let classifierSubtotal = 0;
  for (const [key, usage] of Object.entries(stats.classifierUsageByModel ?? {})) {
    const model = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    const amount = calculateUsageCost(usage, pricing.models[model]);
    if (amount === null) {
      missingModels.push(`classifier:${model}`);
      unpricedTurns += usage.calls ?? 0;
    } else {
      classifierSubtotal += amount;
      pricedTurns += usage.calls ?? 0;
    }
  }
  knownSubtotal += classifierSubtotal;
  const uniqueMissing = [...new Set(missingModels)].sort();
  const costCoverage = pricedTurns + unpricedTurns === 0 ? 'unknown'
    : uniqueMissing.length === 0 ? 'complete'
      : pricedTurns > 0 ? 'partial' : 'unknown';
  const validations = stats.validation ?? {};
  const verified = (validations.passed ?? 0) + (validations.failed ?? 0);
  const attempts = stats.attempts ?? stats.usage?.turns ?? 0;
  const sources = stats.sources ?? {};
  const abstained = (sources.baseline ?? 0) + (stats.abstentions ?? 0);
  const upgrades = (sources.escalation ?? 0) + (sources.fallback ?? 0);
  const measuredLatency = stats.latency?.measured ?? 0;
  const totalLatencyMs = stats.latency?.totalMs ?? 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    billingMode,
    counts: {
      routes: stats.total ?? 0, tasks: stats.tasks ?? 0, attempts,
      retries: stats.retries ?? 0,
    },
    distributions: {
      models: stats.models ?? {}, efforts: stats.efforts ?? {}, modes: stats.modes ?? {}, sources,
    },
    tokens: {
      usage: stats.usage ?? null,
      note: 'Cached input and reasoning output are subdivisions and are not added to token totals again.',
    },
    cost: {
      kind: 'api_token_estimate',
      currency: pricing.currency,
      source: pricing.source,
      effectiveDate: pricing.effectiveDate,
      serviceTier: pricing.serviceTier,
      coverage: costCoverage,
      pricedTurns,
      unpricedTurns,
      missingModels: uniqueMissing,
      knownSubtotal,
      classifierSubtotal,
      totalEstimate: billingMode === 'api' && costCoverage === 'complete' ? knownSubtotal : null,
      observedInvoice: null,
      subscriptionSavings: null,
      note: billingMode === 'subscription'
        ? 'API token prices do not measure subscription quota or billing.'
        : 'This is a token-price estimate, not an observed invoice.',
    },
    evidence: {
      validation: validations,
      validationCoveragePercent: ratio(verified, attempts),
      usageCoverage: stats.usage?.coverage ?? { known: 0, unknown: attempts },
      observedLatencyMsAverage: measuredLatency ? totalLatencyMs / measuredLatency : null,
    },
    routing: {
      upgradeRatePercent: ratio(upgrades, stats.total ?? 0),
      coldStartOrAbstainRatePercent: ratio(abstained, stats.total ?? 0),
      classifierCalls: stats.classifierUsage?.calls ?? 0,
      classifierLatencyMsTotal: stats.classifierUsage?.latencyMs ?? 0,
      classifierLatencyMsPerCall: stats.classifierUsage?.calls
        ? stats.classifierUsage.latencyMs / stats.classifierUsage.calls : null,
    },
    measurements: {
      observed: { status: attempts ? 'available' : 'not_measured', attempts },
      replayed: { status: options.replayReport ? 'available' : 'not_measured' },
      counterfactual: { status: 'not_measured', reason: 'No matched quality-controlled baseline replay was supplied.' },
      unknown: { usageRecords: stats.usage?.coverage?.unknown ?? 0, unpricedTurns },
    },
  };
}

export function formatDashboard(dashboard) {
  const cost = dashboard.cost;
  const dollars = (value) => `${cost.currency} ${value.toFixed(4)}`;
  return [
    'codex-smart dashboard',
    '=====================',
    `Routes: ${dashboard.counts.routes} | Attempts: ${dashboard.counts.attempts} | Retries: ${dashboard.counts.retries}`,
    `Models: ${Object.entries(dashboard.distributions.models).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`,
    `Validated: ${dashboard.evidence.validationCoveragePercent.toFixed(1)}%`,
    `Classifier latency: ${dashboard.routing.classifierLatencyMsPerCall === null ? 'not measured' : `${dashboard.routing.classifierLatencyMsPerCall.toFixed(0)} ms/call`}`,
    `API estimate coverage: ${cost.coverage}`,
    `Known API-price subtotal: ${dollars(cost.knownSubtotal)}`,
    `Total API estimate: ${cost.totalEstimate === null ? 'unknown' : dollars(cost.totalEstimate)}`,
    cost.note,
  ].join('\n');
}
