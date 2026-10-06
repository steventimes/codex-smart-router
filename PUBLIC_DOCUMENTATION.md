# Architecture and operating contract

Codex Smart Router is a loopback WebSocket proxy in front of the native Codex App Server. It does not replace Codex execution.

## Runtime path

1. The TUI initializes one App Server connection.
2. The proxy uses a private RPC ID namespace to consume every paginated `model/list` response on that initialized connection.
3. The router builds a bounded set of advertised, visible, modality-compatible `model × effort` pairs. Effort names are open strings; unsupported values are never synthesized.
4. A schema-validated classifier selects an opaque candidate ID or abstains.
5. Explicit turn, session pin, CLI pin, policy evidence, confidence/risk, and baseline rules produce the final legal pair.
6. The proxy patches `turn/start`; Codex retains auth, sandbox, approvals, tools, and state.
7. Protocol, usage, validation, retry, and scope evidence are correlated by decision/task/thread/turn/attempt IDs.

Catalog membership is not entitlement proof. A pre-execution model rejection refreshes the catalog and may fall back once, only before acceptance, stream output, or a tool side effect. Rate limits, timeouts with unknown state, and accepted turns are not replayed.

## Configuration

Example router JSON:

```json
{
  "configVersion": 2,
  "maxCandidates": 8,
  "confidenceThreshold": 0.6,
  "automaticEfforts": ["low", "medium", "high", "xhigh"],
  "automaticHighModes": [],
  "allowlist": ["gpt-6.1-sol", "gpt-6-luna"],
  "modelProfiles": {
    "gpt-6.1-sol": { "quality": 1, "relativeCost": 1 },
    "gpt-6-luna": { "quality": 0.7, "relativeCost": 0.4 }
  },
  "benchmarkStrategies": {
    "baseline": { "model": "gpt-6.1-sol", "effort": "medium" },
    "joint": { "model": "gpt-6.1-sol", "effort": "high" }
  }
}
```

Profiles and “cheap” labels are user-supplied policy priors; the router does not infer price or quality from model names. `max` and `ultra` are excluded from automatic candidates unless listed in `automaticHighModes`.

Live benchmark example (this can consume subscription/API resources):

```bash
node bin/codex-smart.mjs benchmark run --live --config router.json \
  --max-tasks 2 --max-attempts 4 --max-tokens 20000 --timeout 120000 \
  --output live-report.json
```

`--repair` allows at most one validation-linked repair. Verifiers remain outside model-writable workspaces. Dollar budgets are refused unless the provider has reliable pricing evidence; cancellation may be delayed.

## Result and cost semantics

- `completed`: App Server finished the protocol turn.
- `unknown`: no correctness verifier ran.
- `passed`: explicit trusted validation passed.
- `failed/logic`: capability label eligible for policy fitting.
- infrastructure, permission, timeout, cancellation, unavailable model, and validator tampering: operational evidence, not a model-quality failure.

Usage with incomplete attribution remains `null`. Retries are separate attempts under one task. Cached input is included in input tokens; reasoning tokens are included in output tokens. The dashboard reports price coverage and known subtotals without converting them into subscription savings.

## Classifier boundaries

`auto` and `codex` use an ephemeral, read-only native Codex classifier on a legal catalog pair. `openai` is an explicit paid API destination. `http` targets an explicit OpenAI-compatible endpoint and supports Responses or Chat Completions. No backend silently falls through to a different destination.

The HTTP classifier receives the current bounded prompt, up to six bounded history items, metadata-only repository summary, prior structured outcome, and candidate metadata. API keys, OAuth credentials, raw tools, and audit logs are not sent.

## Offline policy

`policy fit` reads explicit anonymous exports, makes deterministic repository/task/month group splits, and stores per-bucket/per-combination counts, mean tokens/time, smoothed rates, and Wilson intervals. Online use requires enough samples, a known feature bucket, a legal candidate, and a matching catalog fingerprint. No online hot-training or random exploration occurs.

## Compatibility

App Server protocol and model catalogs vary by Codex version. `doctor` checks the installed binary and discovered combinations without running inference. Current-model documentation can describe newer capabilities than an older binary, so runtime schema/catalog evidence wins. See [docs/MIGRATION.md](docs/MIGRATION.md).
