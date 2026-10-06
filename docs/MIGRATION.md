# Migration from 0.1

Version 0.2 replaces fixed tier routing with runtime catalog candidates and a versioned decision/audit contract.

Preview an old router JSON without changing it:

```bash
node bin/codex-smart.mjs migrate --input old-router.json --preview --json
```

Write a separate migrated file only when ready:

```bash
node bin/codex-smart.mjs migrate --input old-router.json --write --output router-v2.json
```

This never edits `~/.codex/config.toml`. Legacy `tiers` are preserved, but their model and effort must now be advertised by the active catalog; the old “nearest effort” substitution is removed. Add sourced `modelProfiles` only if you want tier/cost priors.

Behavior changes:

- `auto` uses native Codex classification even when `OPENAI_API_KEY` exists. Use `--classifier openai` explicitly for paid API classification.
- Models and effort strings come from `model/list`; hard-coded model names are no longer defaults.
- `::route off` is a mode; use `::route pin model=... effort=...` for a session pin and `::route unpin` to clear it.
- Completed turns remain unverified until explicit validation/feedback.
- The dashboard no longer presents counterfactual token repricing as equivalent-quality savings.
- Audit schema v1 remains readable. New audit/export/policy records are versioned and prompt-free.

Recommended check:

```bash
node bin/codex-smart.mjs models --refresh --json
node bin/codex-smart.mjs doctor --json
node bin/codex-smart.mjs route --config router-v2.json --json "Inspect this migration"
```

The last command runs classifier inference but does not execute the requested task.
