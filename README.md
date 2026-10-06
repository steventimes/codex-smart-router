# Codex Smart Router

An experimental local router for the native Codex CLI. It discovers the model catalog exposed by the current Codex binary/account, chooses a legal `model × reasoning effort` pair, and sends the turn through Codex App Server. Authentication, the TUI, tools, approvals, sandboxing, plugins, skills, and thread state stay in Codex.

This fork adds dynamic catalog discovery, joint model/effort routing, result evidence, optional private GPU classification, an offline fitted policy, isolated replay fixtures, and an evidence-aware dashboard. It does not claim measured quality gains or subscription savings.

Upstream: [giovannimirarchi420/codex-smart-router](https://github.com/giovannimirarchi420/codex-smart-router). This checkout is the unpublished fork at [steventimes/codex-smart-router](https://github.com/steventimes/codex-smart-router).

## Quick start

Requirements: Node.js 20+, a Codex CLI that supports `app-server --listen stdio://` and `--remote`, and an existing Codex login.

```bash
git clone https://github.com/steventimes/codex-smart-router.git
cd codex-smart-router
npm install
node bin/codex-smart.mjs models --refresh --json
node bin/codex-smart.mjs doctor --json
node bin/codex-smart.mjs
```

`models` and `doctor` perform no model inference. `route` invokes the configured classifier but does not execute the requested coding task:

```bash
node bin/codex-smart.mjs route --json "Fix the parser and its tests"
```

The default `auto` classifier uses the current Codex subscription. It never switches to the paid OpenAI API merely because `OPENAI_API_KEY` exists.

## Controls

```bash
node bin/codex-smart.mjs --mode auto
node bin/codex-smart.mjs --mode shadow
node bin/codex-smart.mjs --mode off
node bin/codex-smart.mjs --model gpt-6.1-sol --effort high
node bin/codex-smart.mjs --scope minimal --terse
```

The first submitted line may override routing:

```text
::route pin model=gpt-6.1-sol effort=high
Implement the change.
```

Other controls are `::route unpin`, `::route auto|shadow|off`, a one-turn `::route model=... effort=...`, and legacy tier aliases when the configured tier resolves to a legal current combination. Explicit turn selection wins over a session pin, which wins over the CLI pin and baseline.

## Classifiers and data destinations

Native subscription classifier (default):

```bash
node bin/codex-smart.mjs --classifier codex
```

Explicit paid OpenAI API classifier:

```bash
export OPENAI_API_KEY=...
node bin/codex-smart.mjs --classifier openai --classifier-model YOUR_MODEL
```

OpenAI-compatible local/private GPU endpoint:

```bash
export CODEX_SMART_HTTP_API_KEY=optional-token
node bin/codex-smart.mjs \
  --classifier http \
  --classifier-url http://127.0.0.1:8000/v1 \
  --classifier-model YOUR_LOCAL_MODEL \
  --classifier-protocol chat-completions
```

Remote plain HTTP is rejected unless `--allow-insecure-remote` is explicit; prefer HTTPS, SSH forwarding, or a trusted private network. The endpoint receives a bounded routing summary, never Codex OAuth credentials. Classifier failure keeps the legal baseline rather than crossing to another billing/data destination.

## Evidence and offline policy

App Server `completed` means protocol completion, not correctness. Only explicit `passed`, or `failed` with a logic/capability cause, can train the policy. Unknown, not-run, environment, permission, timeout, cancellation, and tampered-validator results are excluded.

```bash
node bin/codex-smart.mjs feedback --attempt ATTEMPT_ID --status passed
node bin/codex-smart.mjs export --output anonymous.jsonl
node bin/codex-smart.mjs policy fit --input anonymous.jsonl --output policy.json
node bin/codex-smart.mjs --policy policy.json
```

The fitted JSON uses Beta smoothing plus Wilson intervals in versioned `taskType × risk × verifiability` buckets. It requires a minimum sample count and an exact known catalog fingerprint; otherwise routing falls back to the classifier/baseline. Observational selection bias remains explicit.

## Benchmark and dashboard

The bundled 12-task replay is synthetic by default and only validates the pipeline:

```bash
node bin/codex-smart.mjs benchmark run --json
node bin/codex-smart.mjs dashboard --no-open
```

Live replay requires `--live`, task/attempt/token/timeout budgets, and legal `benchmarkStrategies` mappings in `--config`. It runs each strategy in an independent temporary directory. It is never started automatically. See [PUBLIC_DOCUMENTATION.md](PUBLIC_DOCUMENTATION.md) for the config shape.

The dashboard separates observed, replayed, counterfactual, and unknown evidence. Cached input and reasoning output are token subdivisions, not extra tokens. API price estimates require an explicit versioned catalog via `CODEX_SMART_PRICING`; they are not invoices or subscription-quota savings.

## Privacy and local state

- Proxy and dashboard bind to `127.0.0.1`; the proxy uses a per-process bearer token.
- No prompt, source, tool body, credential, detailed URL, or free-text rationale is persisted by default.
- Catalog cache: `${CODEX_HOME:-~/.codex}/smart-router/catalogs/`.
- Audit log: `${CODEX_HOME:-~/.codex}/smart-router/routes.jsonl`; disable with `--no-audit`.
- `export` is explicit and anonymous; `prune --keep-days N` or `prune --before TIME` controls retention.
- The router never edits `~/.codex/config.toml`, changes accounts, publishes, or deploys.

## Development

```bash
npm test
npm run check
node bin/codex-smart.mjs benchmark run --json
CODEX_SMART_LIVE_INTEGRATION=1 npm run test:integration  # handshake only; no model turn
```

Migration from 0.1 is documented in [docs/MIGRATION.md](docs/MIGRATION.md). License: Apache-2.0.

## 中文快速使用

本 fork 从当前 Codex 账号的 App Server 动态读取模型与 reasoning effort，校验组合后仍由原生 Codex 执行。默认分类走现有 Codex 订阅，不会因为检测到 API key 就自动改走付费 API。

```bash
npm install
node bin/codex-smart.mjs models --refresh --json
node bin/codex-smart.mjs doctor --json
node bin/codex-smart.mjs --scope minimal
```

GPU 分类器使用 `--classifier http --classifier-url ... --classifier-model ...`。真实 benchmark 必须显式 `--live` 并设置四项预算；默认 benchmark 是 synthetic，不能当成真实成功率或节省比例。
