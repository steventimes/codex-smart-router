import { readdir, stat } from 'node:fs/promises';
import { relative } from 'node:path';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.worktrees', '.superpowers']);

function boundedText(value, maxCharacters) {
  const text = String(value ?? '');
  return text.length <= maxCharacters ? text : text.slice(0, maxCharacters);
}

export function buildTaskFeatures({
  prompt,
  history = [],
  hasImages = false,
  context = {},
  repositorySummary = null,
} = {}) {
  return {
    schemaVersion: 1,
    prompt: boundedText(prompt, 12_000),
    history: history.slice(-6).map((entry) => boundedText(entry, 2_000)),
    hasImages: Boolean(hasImages),
    contextIncomplete: Boolean(context?.contextIncomplete),
    previous: {
      decision: context?.previousDecision ?? null,
      status: context?.previousStatus ?? null,
      validation: context?.previousValidation ?? null,
      failureType: context?.previousFailureType ?? null,
      usage: context?.previousUsage ?? null,
    },
    repositorySummary,
  };
}

export async function summarizeRepository(root, {
  maxFiles = 80,
  maxBytes = 32_000,
  timeoutMs = 150,
} = {}) {
  const started = Date.now();
  const files = [];
  let bytes = 0;
  let truncated = false;

  async function visit(directory) {
    if (Date.now() - started > timeoutMs || files.length >= maxFiles || bytes >= maxBytes) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (Date.now() - started > timeoutMs || files.length >= maxFiles || bytes >= maxBytes) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        const path = relative(root, fullPath);
        const entryBytes = Buffer.byteLength(path) + 32;
        if (bytes + entryBytes > maxBytes) {
          truncated = true;
          return;
        }
        files.push({ path, size: info.size, modifiedAt: info.mtime.toISOString() });
        bytes += entryBytes;
      }
    }
  }

  await visit(root);
  return {
    generatedAt: new Date().toISOString(),
    files,
    truncated,
    elapsedMs: Date.now() - started,
    byteBudget: maxBytes,
  };
}
