#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/app-server-client.mjs';
import {
  appendAuditEvent, defaultAuditPath, exportAnonymousAudit, pruneAudit, readAuditStats,
} from '../src/audit.mjs';
import { createNativeBenchmarkProvider, loadBenchmarkFixtures, runBenchmark, summarizeBenchmark, validateLiveBudgets } from '../src/benchmark.mjs';
import { ModelRegistry, summarizeCatalog, validateCombination } from '../src/catalog.mjs';
import { createClassifier } from '../src/classifier.mjs';
import { previewConfigMigration } from '../src/config-migration.mjs';
import { buildDashboard, formatDashboard } from '../src/dashboard.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { buildDoctorReport } from '../src/doctor.mjs';
import { evaluatePolicy, fitPolicy, loadPolicy } from '../src/policy.mjs';
import { startProxy } from '../src/proxy.mjs';
import { mergeConfig, routePrompt } from '../src/router.mjs';

const execFileAsync = promisify(execFile);

const HELP = `codex-smart - catalog-driven model × reasoning router for Codex

Usage:
  codex-smart [options] [--] [codex arguments]
  codex-smart models [--refresh] [--json]
  codex-smart doctor [--json]
  codex-smart route [--json] <prompt>
  codex-smart policy fit|evaluate|inspect --input <file> [--output <file>]
  codex-smart benchmark run|report [--json]
  codex-smart stats [--json]
  codex-smart dashboard [--port <port>] [--no-open]
  codex-smart export --output <file>
  codex-smart prune (--before <ISO time> | --keep-days <days>)
  codex-smart feedback --attempt <id> --status passed|failed [--failure logic]
  codex-smart migrate --input <old.json> --preview [--write --output <new.json>]

Routing options:
  --mode auto|shadow|off       Runtime routing mode
  --model <slug> --effort <e> CLI session pin (both required)
  --scope minimal|balanced|unrestricted
  --policy <file>              Load an explicitly fitted policy
  --classifier auto|codex|openai|http
  --classifier-model <model>   Classifier model override
  --classifier-url <url>       OpenAI-compatible GPU/private HTTP endpoint
  --classifier-protocol responses|chat-completions
  --allow-insecure-remote      Trust an explicitly configured non-loopback HTTP endpoint
  --config <file> --codex <path> --terse --no-audit

Live benchmark safety:
  --live --max-tasks N --max-attempts N --max-tokens N --timeout MS
  A live execution provider must also be explicitly configured; mock is the default.

Prompt controls (first submitted line only):
  ::route auto|shadow|off|unpin
  ::route pin model=<slug> effort=<value>
  ::route model=<slug> effort=<value>
`;

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const known = new Set(['route', 'models', 'doctor', 'stats', 'dashboard', 'policy', 'benchmark', 'export', 'prune', 'feedback', 'migrate', 'help']);
  const result = {
    command: known.has(argv[0]) ? argv[0] : 'launch',
    subcommand: null,
    codexPath: process.env.CODEX_SMART_CODEX || 'codex',
    configPath: process.env.CODEX_SMART_CONFIG,
    classifierMode: process.env.CODEX_SMART_CLASSIFIER || 'auto',
    classifierModel: process.env.CODEX_SMART_CLASSIFIER_MODEL,
    classifierUrl: process.env.CODEX_SMART_CLASSIFIER_URL,
    classifierProtocol: process.env.CODEX_SMART_CLASSIFIER_PROTOCOL ?? 'responses',
    classifierTimeoutMs: process.env.CODEX_SMART_CLASSIFIER_TIMEOUT ? Number(process.env.CODEX_SMART_CLASSIFIER_TIMEOUT) : undefined,
    allowInsecureRemote: false,
    verbosity: 'low', terse: false, audit: true, json: false, refresh: false,
    mode: 'auto', scopePolicy: null, cliPin: null, model: null, effort: null,
    policyPath: process.env.CODEX_SMART_POLICY,
    catalogPath: null, auditPath: process.env.CODEX_SMART_AUDIT_PATH,
    inputPath: null, outputPath: null, reportPath: null,
    dashboardPort: undefined, openDashboard: true, billingMode: 'subscription',
    live: false, repair: false, maxTasks: undefined, maxAttempts: undefined,
    maxTokens: undefined, timeoutMs: undefined, maxDollars: undefined,
    before: null, keepDays: undefined, attemptId: null, validationStatus: null, failureType: null,
    preview: false, write: false,
    rest: [],
  };
  let index = result.command === 'launch' ? 0 : 1;
  if (['policy', 'benchmark'].includes(result.command) && argv[index] && !argv[index].startsWith('-')) {
    result.subcommand = argv[index++];
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { result.rest.push(...argv.slice(index + 1)); break; }
    const take = () => optionValue(argv, index++, arg);
    if (arg === '--config') result.configPath = take();
    else if (arg === '--codex') result.codexPath = take();
    else if (arg === '--classifier') result.classifierMode = take();
    else if (arg === '--classifier-model') result.classifierModel = take();
    else if (arg === '--classifier-url') result.classifierUrl = take();
    else if (arg === '--classifier-protocol') result.classifierProtocol = take();
    else if (arg === '--classifier-timeout') result.classifierTimeoutMs = Number(take());
    else if (arg === '--allow-insecure-remote') result.allowInsecureRemote = true;
    else if (arg === '--verbosity') result.verbosity = take();
    else if (arg === '--terse') result.terse = true;
    else if (arg === '--no-audit') result.audit = false;
    else if (arg === '--json') result.json = true;
    else if (arg === '--refresh') result.refresh = true;
    else if (arg === '--mode') result.mode = take();
    else if (arg === '--scope') result.scopePolicy = take();
    else if (arg === '--model') result.model = take();
    else if (arg === '--effort') result.effort = take();
    else if (arg === '--policy') result.policyPath = take();
    else if (arg === '--catalog') result.catalogPath = take();
    else if (arg === '--audit-path') result.auditPath = take();
    else if (arg === '--input') result.inputPath = take();
    else if (arg === '--output') result.outputPath = take();
    else if (arg === '--report') result.reportPath = take();
    else if (arg === '--port') result.dashboardPort = Number(take());
    else if (arg === '--no-open') result.openDashboard = false;
    else if (arg === '--billing') result.billingMode = take();
    else if (arg === '--live') result.live = true;
    else if (arg === '--repair') result.repair = true;
    else if (arg === '--max-tasks') result.maxTasks = Number(take());
    else if (arg === '--max-attempts') result.maxAttempts = Number(take());
    else if (arg === '--max-tokens') result.maxTokens = Number(take());
    else if (arg === '--timeout') result.timeoutMs = Number(take());
    else if (arg === '--max-dollars') result.maxDollars = Number(take());
    else if (arg === '--before') result.before = take();
    else if (arg === '--keep-days') result.keepDays = Number(take());
    else if (arg === '--attempt') result.attemptId = take();
    else if (arg === '--status') result.validationStatus = take();
    else if (arg === '--failure') result.failureType = take();
    else if (arg === '--preview') result.preview = true;
    else if (arg === '--write') result.write = true;
    else if (arg === '-h' || arg === '--help') result.command = 'help';
    else if (result.command === 'launch' || !arg.startsWith('-')) result.rest.push(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if ((result.model && !result.effort) || (!result.model && result.effort)) throw new Error('--model and --effort must be provided together');
  if (result.model) result.cliPin = { model: result.model, effort: result.effort };
  if (!['auto', 'shadow', 'off'].includes(result.mode)) throw new Error(`Invalid routing mode: ${result.mode}`);
  if (result.scopePolicy && !['minimal', 'balanced', 'unrestricted'].includes(result.scopePolicy)) throw new Error(`Invalid scope policy: ${result.scopePolicy}`);
  if (!['auto', 'codex', 'openai', 'http'].includes(result.classifierMode)) throw new Error(`Invalid classifier mode: ${result.classifierMode}`);
  if (!['responses', 'chat-completions'].includes(result.classifierProtocol)) throw new Error(`Invalid classifier protocol: ${result.classifierProtocol}`);
  if (result.command === 'migrate' && !result.preview && !result.write) throw new Error('migrate requires --preview or --write');
  if (result.live) result.liveBudgets = validateLiveBudgets(result);
  return result;
}

async function loadConfig(path) {
  if (!path) return mergeConfig();
  return mergeConfig(JSON.parse(await readFile(resolve(path), 'utf8')));
}

async function readJsonLines(path) {
  const content = await readFile(resolve(path), 'utf8');
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function binaryVersion(codexPath) {
  const { stdout } = await execFileAsync(codexPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return stdout.trim();
}

async function protocolSupport(codexPath) {
  const [{ stdout: rootHelp }, { stdout: appServerHelp }] = await Promise.all([
    execFileAsync(codexPath, ['--help'], { encoding: 'utf8', timeout: 5000 }),
    execFileAsync(codexPath, ['app-server', '--help'], { encoding: 'utf8', timeout: 5000 }),
  ]);
  return {
    appServerModelList: true,
    remoteWebSocket: rootHelp.includes('--remote'),
    stdioListen: appServerHelp.includes('stdio://') || appServerHelp.includes('--stdio'),
  };
}

function identityScope(account) {
  const value = account?.account ?? account ?? {};
  return JSON.stringify({
    type: value.type ?? account?.authMode ?? 'unknown',
    id: value.id ?? value.accountId ?? value.email ?? 'unknown',
    plan: account?.planType ?? value.planType ?? 'unknown',
  });
}

async function discoverCatalog(options) {
  if (options.catalogPath) return JSON.parse(await readFile(resolve(options.catalogPath), 'utf8'));
  const client = new AppServerClient({ codexPath: options.codexPath, timeoutMs: options.timeoutMs ?? 15_000 });
  try {
    await client.start();
    let account = null;
    try { account = await client.account(); } catch { /* Account scope remains unknown on older servers. */ }
    const registry = new ModelRegistry({
      codexPath: options.codexPath,
      binaryVersion: await binaryVersion(options.codexPath),
      identityScope: identityScope(account),
      clientFactory: async () => client,
      debugCatalogLoader: null,
    });
    return await registry.discover({ refresh: options.refresh });
  } finally {
    await client.close();
  }
}

function classifierFor(options, nativeCombination) {
  return createClassifier({
    mode: options.classifierMode,
    model: options.classifierModel,
    nativeCombination,
    codexPath: options.codexPath,
    timeoutMs: options.classifierTimeoutMs,
    baseUrl: options.classifierUrl,
    protocol: options.classifierProtocol,
    allowInsecureRemote: options.allowInsecureRemote,
  });
}

function formatRoute(decision) {
  return [
    `model: ${decision.execution.model}`,
    `effort: ${decision.execution.effort}`,
    `source: ${decision.source}`,
    `type: ${decision.taskType}`,
    `classifier confidence: ${decision.classifierConfidence ?? 'not measured'}`,
    `validated policy samples: ${decision.statisticalEvidenceCount}`,
  ].join('\n');
}

async function launchCodex(options, config, policy) {
  const classifier = classifierFor(options);
  const proxy = await startProxy({
    codexPath: options.codexPath, classifier, config, policy,
    verbosity: options.verbosity, terse: options.terse, scopePolicy: options.scopePolicy,
    mode: options.mode, cliPin: options.cliPin,
    audit: options.audit, auditPath: options.auditPath,
  });
  process.stderr.write(`codex-smart: ${options.mode} routing; classifier=${classifier.describe()}\n`);
  const tokenVariable = 'CODEX_SMART_REMOTE_TOKEN';
  const child = spawn(options.codexPath, ['--remote', proxy.url, '--remote-auth-token-env', tokenVariable, ...options.rest], {
    stdio: 'inherit', env: { ...process.env, [tokenVariable]: proxy.authToken },
  });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => accept(signal ? 1 : (exitCode ?? 1)));
  });
  await proxy.close();
  return code;
}

async function policyCommand(options) {
  if (!['fit', 'evaluate', 'inspect'].includes(options.subcommand)) throw new Error('policy requires fit, evaluate, or inspect');
  if (options.subcommand === 'fit') {
    if (!options.inputPath) throw new Error('policy fit requires --input');
    const artifact = fitPolicy(await readJsonLines(options.inputPath));
    const output = resolve(options.outputPath ?? 'codex-smart-policy.json');
    await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    return { output, training: artifact.training, buckets: Object.keys(artifact.buckets).length };
  }
  const path = options.inputPath ?? options.policyPath;
  if (!path) throw new Error(`policy ${options.subcommand} requires --input or --policy`);
  const policy = await loadPolicy(resolve(path));
  if (options.subcommand === 'inspect') return policy;
  if (!options.reportPath) throw new Error('policy evaluate requires --report with anonymous JSONL records');
  return evaluatePolicy(policy, await readJsonLines(options.reportPath));
}

async function benchmarkCommand(options) {
  if (!options.subcommand || options.subcommand === 'run') {
    let provider;
    let strategies;
    if (options.live) {
      const config = await loadConfig(options.configPath);
      if (!config.benchmarkStrategies || typeof config.benchmarkStrategies !== 'object') {
        throw new Error('Live benchmark requires benchmarkStrategies model/effort mappings in --config');
      }
      const catalog = await discoverCatalog({ ...options, refresh: true });
      strategies = Object.keys(config.benchmarkStrategies);
      if (strategies.length === 0) throw new Error('Live benchmark has no configured strategies');
      const combinations = Object.fromEntries(strategies.map((strategy) => [
        strategy, validateCombination(catalog, config.benchmarkStrategies[strategy]),
      ]));
      provider = createNativeBenchmarkProvider({ codexPath: options.codexPath, combinations });
    }
    const report = await runBenchmark({
      fixtures: await loadBenchmarkFixtures(options.inputPath ? resolve(options.inputPath) : undefined),
      strategies,
      mode: options.live ? 'live' : 'mock', budgets: options.liveBudgets,
      provider, repair: options.repair,
    });
    if (options.outputPath) await writeFile(resolve(options.outputPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  }
  if (options.subcommand === 'report') {
    if (!options.inputPath) throw new Error('benchmark report requires --input');
    return summarizeBenchmark(JSON.parse(await readFile(resolve(options.inputPath), 'utf8')));
  }
  throw new Error('benchmark requires run or report');
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const options = parseArgs(argv);
  if (options.command === 'help') { io.stdout.write(HELP); return 0; }
  if (options.command === 'benchmark') {
    const result = await benchmarkCommand(options);
    io.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (options.command === 'policy') {
    io.stdout.write(`${JSON.stringify(await policyCommand(options), null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'export') {
    const result = await exportAnonymousAudit(options.auditPath ?? defaultAuditPath(), resolve(options.outputPath ?? 'codex-smart-anonymous.jsonl'));
    io.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'prune') {
    const result = await pruneAudit(options.auditPath ?? defaultAuditPath(), { before: options.before, keepDays: options.keepDays });
    io.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'feedback') {
    if (!options.attemptId || !['passed', 'failed'].includes(options.validationStatus)) throw new Error('feedback requires --attempt and --status passed|failed');
    if (options.validationStatus === 'failed' && !options.failureType) throw new Error('failed feedback requires --failure');
    const record = await appendAuditEvent({
      event: 'validation', eventId: `${options.attemptId}:user:${Date.now()}`,
      attemptId: options.attemptId, validationStatus: options.validationStatus,
      failureType: options.validationStatus === 'failed' ? options.failureType : null,
      reasonCodes: ['checker:user-feedback'],
    }, options.auditPath);
    io.stdout.write(`${JSON.stringify(record, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'migrate') {
    if (!options.inputPath) throw new Error('migrate requires --input');
    if (!options.preview && !options.write) throw new Error('migrate requires --preview or --write');
    if (options.write && !options.outputPath) throw new Error('migrate --write requires --output');
    const preview = previewConfigMigration(JSON.parse(await readFile(resolve(options.inputPath), 'utf8')));
    if (options.write) await writeFile(resolve(options.outputPath), `${JSON.stringify(preview.config, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`${JSON.stringify({ ...preview, output: options.write ? resolve(options.outputPath) : null }, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'stats') {
    const stats = await readAuditStats(options.auditPath);
    io.stdout.write(`${JSON.stringify(stats, null, options.json ? 0 : 2)}\n`);
    return 0;
  }
  if (options.command === 'dashboard') {
    const dashboard = await startDashboardServer({
      port: options.dashboardPort, auditPath: options.auditPath,
      pricing: process.env.CODEX_SMART_PRICING, billingMode: options.billingMode,
    });
    io.stdout.write(`${dashboard.url}\n`);
    if (options.openDashboard) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', dashboard.url] : [dashboard.url];
      spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
    }
    return new Promise(() => {});
  }

  const config = await loadConfig(options.configPath);
  const policy = options.policyPath ? await loadPolicy(resolve(options.policyPath)) : null;
  if (options.command === 'models' || options.command === 'doctor' || options.command === 'route') {
    const catalog = await discoverCatalog(options);
    if (options.command === 'models') {
      const value = options.json ? { ...catalog, models: summarizeCatalog(catalog) } : summarizeCatalog(catalog);
      io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      return 0;
    }
    if (options.command === 'doctor') {
      const protocol = await protocolSupport(options.codexPath);
      const report = buildDoctorReport({
        binary: { path: options.codexPath, version: await binaryVersion(options.codexPath) },
        catalog,
        classifier: { mode: options.classifierMode, destination: options.classifierMode === 'http' ? options.classifierUrl : options.classifierMode },
        protocol: { ...protocol, appServerModelList: protocol.appServerModelList && catalog.source === 'app-server-model-list' },
        cache: { path: options.catalogPath ?? 'scoped runtime cache', stale: Boolean(catalog.stale) },
      });
      io.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }
    const prompt = options.rest.join(' ');
    if (!prompt) throw new Error('route requires a prompt');
    const baseline = options.cliPin ?? undefined;
    const classifier = classifierFor(options, baseline);
    const decision = await routePrompt(prompt, catalog, { config, classifier, policy, cliPin: options.cliPin, baseline });
    io.stdout.write(options.json ? `${JSON.stringify(decision)}\n` : `${formatRoute(decision)}\n`);
    return 0;
  }
  return launchCodex(options, config, policy);
}

export function isCliEntryPoint(path = process.argv[1]) {
  if (!path) return false;
  try {
    return realpathSync(resolve(path)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const isEntryPoint = isCliEntryPoint();
if (isEntryPoint) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`codex-smart: ${error.message}\n`);
    process.exitCode = 1;
  });
}
