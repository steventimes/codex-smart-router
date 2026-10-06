export function buildDoctorReport({ binary, catalog, classifier, cache = null, protocol = null }) {
  const visibleModels = catalog.models.filter((model) => !model.hidden);
  const legalCombinations = visibleModels.reduce(
    (total, model) => total + model.supportedReasoningEfforts.length,
    0,
  );
  const warnings = [];
  if (catalog.stale) warnings.push('Model catalog cache is stale.');
  if (legalCombinations === 0) warnings.push('No legal model and reasoning-effort combinations are available.');
  if (catalog.source !== 'app-server-model-list') {
    warnings.push('Model catalog uses a compatibility source and is not a live App Server model/list snapshot.');
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ok: Boolean(binary?.version) && visibleModels.length > 0 && legalCombinations > 0
      && protocol?.appServerModelList !== false && protocol?.remoteWebSocket !== false && protocol?.stdioListen !== false,
    binary,
    protocol,
    catalog: {
      source: catalog.source,
      stale: Boolean(catalog.stale),
      fingerprint: catalog.fingerprint ?? null,
      provider: catalog.scope?.provider ?? catalog.provider ?? null,
      identityHash: catalog.scope?.identityHash ?? null,
      visibleModels: visibleModels.length,
      hiddenModels: catalog.models.length - visibleModels.length,
      legalCombinations,
    },
    cache,
    classifier,
    warnings,
  };
}
