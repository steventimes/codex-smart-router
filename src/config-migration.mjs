export const CURRENT_CONFIG_VERSION = 2;

export function previewConfigMigration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Router config must be a JSON object');
  const fromVersion = Number.isInteger(input.configVersion) ? input.configVersion : 1;
  if (fromVersion > CURRENT_CONFIG_VERSION) throw new Error(`Config version ${fromVersion} is newer than this router supports`);
  const migrated = structuredClone(input);
  migrated.configVersion = CURRENT_CONFIG_VERSION;
  migrated.maxCandidates ??= 8;
  migrated.confidenceThreshold ??= 0.6;
  migrated.automaticEfforts ??= ['low', 'medium', 'high', 'xhigh'];
  migrated.automaticHighModes ??= [];
  migrated.modelProfiles ??= {};
  migrated.tiers ??= {};
  return {
    schemaVersion: 1,
    fromVersion,
    toVersion: CURRENT_CONFIG_VERSION,
    changed: JSON.stringify(input) !== JSON.stringify(migrated),
    changes: [
      'Adds versioned joint model/effort candidate defaults.',
      'Preserves legacy tier mappings, but every combination is now validated against the runtime catalog.',
      'Does not enable paid API classification or edit Codex global configuration.',
    ],
    config: migrated,
  };
}
