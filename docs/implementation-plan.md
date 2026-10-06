# Adaptive Codex Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed tier-to-model routing with a catalog-driven, evidence-aware `model × reasoning effort` router that preserves native Codex App Server execution and remains fully testable offline.

**Architecture:** A standalone App Server protocol client feeds a scoped, cached `ModelRegistry`; the proxy reuses the already initialized App Server connection and owns a private RPC ID namespace for refreshes. Routing builds a bounded set of legal combinations, validates classifier output against candidate IDs, applies explicit/session/baseline precedence, and records execution and validation evidence. Optional HTTP classification, policy fitting, benchmark replay, and dashboard reporting consume the same versioned decision, result, and audit contracts.

**Tech Stack:** Node.js 20+ ES modules, Node `node:test`, newline-delimited JSON-RPC over stdio/WebSocket, built-in `fetch`, JSON/JSONL artifacts, and the existing `ws` dependency.

**Spec:** `codex-smart-router-fork-prompt.md`

## Global Constraints

- Preserve the native Codex login, TUI, tools, approvals, sandbox, plugins, skills, and thread state.
- Do not edit `~/.codex/config.toml`, change accounts, publish, push, deploy, or start a paid/live benchmark without explicit opt-in.
- Runtime `model/list` for the same binary/provider/identity is authoritative for selectable combinations; catalog membership is not entitlement proof.
- Treat reasoning effort as an open non-empty string and never synthesize an unsupported value.
- Store no prompt, source, tool body, credential, sensitive URL, or free-text rationale in persistent audit/training artifacts.
- Keep the install path lightweight: JavaScript only, no required GPU, Python, database, or inference server.
- JSON CLI stdout is machine-only; diagnostics and redacted warnings go to stderr.

## Review Focus

- A catalog can paginate, be empty, omit optional modalities, contain unknown efforts, be stale/corrupt, or change identity/provider between reads.
- A classifier can time out, return malformed JSON, or name a candidate absent from the exact bounded candidate set.
- A turn can be cancelled, rejected before execution, reconnect, reset cumulative usage, or emit duplicate/late events after another turn starts.
- A completed turn can remain unverified; infrastructure failure and deleted validators must never become model-quality labels.
- Missing prices, missing usage fields, and mock benchmark outcomes must stay unknown/synthetic rather than becoming zero, savings, or success claims.

---

### Task 1: App Server protocol client and ModelRegistry

**Files:**
- Create: `src/app-server-client.mjs`
- Replace: `src/catalog.mjs`
- Create: `src/doctor.mjs`
- Test: `test/catalog.test.mjs`
- Test: `test/app-server-client.test.mjs`

**Interfaces:**
- Produces `AppServerClient`, `ModelRegistry`, `normalizeCatalogModel()`, `validateCombination()`, and `buildDoctorReport()`.
- Catalog snapshots include schema/version/source/time/provider/scope/fingerprint/stale and per-model availability evidence.

- [x] Write tests for paginated `model/list`, one initialize, private string IDs, unknown effort preservation, legacy conversion, missing modalities, empty pages, timeouts, cache corruption, cache scope isolation, refresh coalescing, and denied evidence invalidation.
- [x] Run the focused tests and verify the expected missing-export failures.
- [x] Implement the newline JSON-RPC client, catalog normalization/validation, atomic scoped cache, TTL/fingerprint logic, debug-model compatibility adapter, and doctor checks.
- [x] Run focused tests, then the whole suite.

### Task 2: Joint candidates, controls, and classifier backends

**Files:**
- Replace: `assets/route-schema.json`
- Replace: `src/router.mjs`
- Replace: `src/classifier.mjs`
- Create: `src/task-context.mjs`
- Test: `test/router.test.mjs`
- Test: `test/classifier.test.mjs`
- Test: `test/task-context.test.mjs`

**Interfaces:**
- Produces versioned `TaskFeatures` and `RouteDecision`, bounded candidates with opaque IDs, `SessionRouteState`, and Codex/Responses/Chat-Completions classifier adapters.
- Candidate decisions always pass `validateCombination()` before proxy execution.

- [x] Write failing tests for cross-model/cross-effort candidates, strong-low versus efficient-high, modality/capability filtering, unknown efforts, abstain/baseline behavior, cooldown/minimum gain, continuation inheritance, pin/unpin, auto/shadow/off, and CLI precedence.
- [x] Write failing backend tests for strict Responses, local JSON Responses, Chat Completions, malformed output, timeout, unknown candidate, no implicit paid fallback, recursion guard, and request-size bounds.
- [x] Implement candidate construction and schema-validated joint selection without name heuristics; preserve the compatibility tier entry points as policy priors.
- [x] Implement first-line-only directives while preserving every input item and explicit session controls.
- [x] Run focused tests, then the whole suite.

### Task 3: Native proxy execution, evidence, validation, scope, and audit

**Files:**
- Replace: `src/proxy.mjs`
- Replace: `src/audit.mjs`
- Create: `src/validation.mjs`
- Create: `src/scope-policy.mjs`
- Test: `test/proxy.test.mjs`
- Test: `test/validation.test.mjs`
- Test: `test/scope-policy.test.mjs`
- Test: `test/audit.test.mjs`
- Test: `test/e2e.mock.test.mjs`

**Interfaces:**
- Produces connection/thread/turn/attempt correlation, `ValidationResult`, scope reports, availability updates, and schema-versioned idempotent audit events.
- The end-to-end mock path covers directory → route → patched native turn → events → verification → next-turn upgrade → off baseline restore.

- [x] Write failing protocol tests for internal RPC collisions, initialize reuse, Unicode fragments, non-blocking control traffic, concurrent turns, cancellation, duplicate/late usage, child exit, and replay eligibility.
- [x] Write failing evidence tests for completed/unknown, verified failure escalation, infrastructure neutrality, retry/budget stop, validator integrity, dirty-state preservation, and scope warnings.
- [x] Implement proxy correlation and internal catalog requests on the initialized connection; synchronize collaboration settings only when present and supported.
- [x] Implement structured validators, next-turn escalation, bounded fallback-before-execution, scope context/reporting, and backward-compatible private audit records.
- [x] Run the mock end-to-end test and full suite.

### Task 4: Offline policy, benchmark harness, dashboard, and CLI

**Files:**
- Create: `src/policy.mjs`
- Create: `src/benchmark.mjs`
- Create: `assets/benchmark/tasks.json`
- Replace: `src/dashboard.mjs`
- Replace: `src/dashboard-server.mjs`
- Replace: `bin/codex-smart.mjs`
- Modify: `package.json`
- Test: `test/policy.test.mjs`
- Test: `test/benchmark.test.mjs`
- Test: `test/dashboard.test.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Produces deterministic `fitPolicy()`, `evaluatePolicy()`, `loadPolicy()`, isolated synthetic replay, live-budget gates, dashboard coverage metrics, export/prune, and all documented CLI commands.

- [x] Write failing policy tests for Wilson-smoothed validated labels, minimum samples, reproducible task/repo/time splits, unknown-model fallback, and actual online use.
- [x] Write failing benchmark tests for at least 12 original deterministic fixtures, two multi-turn tasks, independent initial state, protected verifiers, synthetic/live labels, explicit live budgets, and one bounded repair.
- [x] Write failing dashboard/CLI tests for usage subdivisions, retries, partial price coverage, subscription/API distinctions, secret redaction, old logs, package resources, JSON stdout, retention, and anonymous export.
- [x] Implement the policy artifact, benchmark runner/report, expanded dashboard, and CLI wiring.
- [x] Run focused tests, benchmark mock, and full suite.

### Task 5: Documentation, migration, packaging, and final verification

**Files:**
- Replace: `README.md`
- Replace: `PUBLIC_DOCUMENTATION.md`
- Modify: `CHANGELOG.md`
- Create: `docs/MIGRATION.md`
- Modify: `package.json`

**Interfaces:**
- Documents upstream versus fork behavior, explicit data/billing destinations, GPU HTTP setup, migration preview, current origin, local install, runtime limitations, and evidence semantics.

- [x] Update English primary docs plus a concise Chinese quick start; remove unsupported savings claims and public-package install commands for this unpublished fork.
- [x] Document config migration, cache/audit locations, trust requirements for remote classifiers, live benchmark opt-in, and verified versus unverified states.
- [x] Run `npm test`, `npm run check`, mock end-to-end, `benchmark run` in mock mode, and `npm pack --dry-run`.
- [x] Install the tarball in a temporary directory and run help/models-offline smoke checks.
- [x] Run the real App Server integration only behind its explicit environment switch; report pass/fail/skip separately and do not run paid inference.
