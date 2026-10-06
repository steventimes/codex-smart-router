import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendAudit, appendAuditEvent, appendUsageAudit, readAuditStats } from "../src/audit.mjs";

test("records prompt-free routes and aggregates real token usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-smart-audit-"));
  const path = join(directory, "routes.jsonl");
  await appendAudit({
    routeId: "route-1",
    threadId: "thread-1",
    tier: "economy",
    score: 12,
    model: "gpt-5.4-mini",
    effort: "low",
    overridden: false,
    confidence: 0.9,
    taskType: "transformation",
    classifier: {
      provider: "openai-api",
      model: "gpt-5.4-nano",
      latencyMs: 200,
      usage: {
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 340
      }
    },
  }, path);
  await appendUsageAudit({
    routeId: "route-1",
    threadId: "thread-1",
    turnId: "turn-1",
    tier: "economy",
    model: "gpt-5.4-mini",
    effort: "low",
    status: "completed",
    durationMs: 100,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
    },
  }, path);

  const content = await readFile(path, "utf8");
  assert.doesNotMatch(content, /Fix a typo/);

  const stats = await readAuditStats(path);
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.tiers, { economy: 1 });
  assert.equal(stats.usage.turns, 1);
  assert.equal(stats.usage.totalTokens, 120);
  assert.equal(stats.usage.reasoningOutputTokens, 5);
  assert.equal(stats.averageConfidence, 0.9);
  assert.equal(stats.classifierUsage.totalTokens, 340);
});

test('deduplicates schema v2 events and never persists prompt-like or secret fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-audit-v2-'));
  const path = join(directory, 'routes.jsonl');
  const event = {
    schemaVersion: 2,
    event: 'attempt',
    eventId: 'event-1',
    decisionId: 'decision-1',
    taskId: 'task-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    model: 'model-a',
    effort: 'low',
    routeSource: 'classifier',
    protocolStatus: 'completed',
    validationStatus: 'unknown',
    reasonCodes: ['semantic_match'],
    usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
    prompt: 'DO_NOT_STORE_THIS_PROMPT',
    rationale: 'DO_NOT_STORE_THIS_REASON',
    apiKey: 'sk-secret',
    cwd: '/private/source/path',
  };
  await appendAuditEvent(event, path);
  await appendAuditEvent(event, path);
  const content = await readFile(path, 'utf8');
  assert.doesNotMatch(content, /DO_NOT_STORE|sk-secret|private\/source/);

  const stats = await readAuditStats(path);
  assert.equal(stats.usage.turns, 1);
  assert.equal(stats.usage.inputTokens, 100);
  assert.equal(stats.usage.cachedInputTokens, 80);
  assert.equal(stats.usage.outputTokens, 20);
  assert.equal(stats.usage.reasoningOutputTokens, 5);
  assert.equal(stats.usage.totalTokens, 120);
  assert.equal(stats.validation.unknown, 1);
});

test('preserves missing usage as null and reports coverage instead of treating it as zero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-smart-audit-null-'));
  const path = join(directory, 'routes.jsonl');
  await appendAuditEvent({
    schemaVersion: 2,
    event: 'attempt',
    eventId: 'unknown-usage',
    decisionId: 'decision-2',
    taskId: 'task-2',
    attemptId: 'attempt-2',
    protocolStatus: 'interrupted',
    validationStatus: 'not_run',
    usage: null,
  }, path);
  const stats = await readAuditStats(path);
  assert.equal(stats.usage.inputTokens, null);
  assert.equal(stats.usage.totalTokens, null);
  assert.equal(stats.usage.coverage.known, 0);
  assert.equal(stats.usage.coverage.unknown, 1);
});
