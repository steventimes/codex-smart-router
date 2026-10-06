const POLICIES = new Set(['minimal', 'balanced', 'unrestricted']);

function matchesAllowed(path, allowed) {
  return allowed.some((entry) => path === entry || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`));
}

export function buildScopeContext({ policy = 'balanced', allowedPaths = [], userInstruction = null } = {}) {
  if (!POLICIES.has(policy)) throw new Error(`Invalid scope policy: ${policy}`);
  const guidance = {
    minimal: 'Change only the necessary files and avoid unrelated refactors, new dependencies, or public interface changes.',
    balanced: 'Keep changes focused on the requested outcome and include the tests or supporting edits needed for correctness.',
    unrestricted: 'Follow the user request without an additional router scope restriction.',
  }[policy];
  return {
    kind: 'application',
    policy,
    allowedPaths: [...allowedPaths],
    text: userInstruction ? `${guidance} User-specified scope: ${userInstruction}` : guidance,
  };
}

export function compareScopeState(before, after, { allowedPaths = [], validatorPaths = [] } = {}) {
  const beforeFiles = before?.files ?? {};
  const afterFiles = after?.files ?? {};
  const preExistingDirty = Object.keys(beforeFiles).sort();
  const allPaths = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const changedByTask = [...allPaths].filter((path) => {
    const earlier = beforeFiles[path];
    const later = afterFiles[path];
    return JSON.stringify(earlier ?? null) !== JSON.stringify(later ?? null);
  }).sort();
  const outOfScope = allowedPaths.length === 0
    ? []
    : changedByTask.filter((path) => !matchesAllowed(path, allowedPaths));
  const deletedValidators = validatorPaths.filter((path) => beforeFiles[path] && !afterFiles[path]);
  const modifiedValidators = validatorPaths.filter((path) => (
    beforeFiles[path] && afterFiles[path] && beforeFiles[path].hash !== afterFiles[path].hash
  ));
  return {
    preExistingDirty,
    changedByTask,
    outOfScope,
    uncertain: [],
    action: 'warn_only',
    validatorIntegrity: deletedValidators.length || modifiedValidators.length ? 'failed' : 'unchanged',
    deletedValidators,
    modifiedValidators,
  };
}
