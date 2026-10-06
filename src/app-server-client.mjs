import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

function exitDescription(code, signal, stderr) {
  const suffix = stderr.trim().slice(-1_000);
  if (signal) return `Codex App Server exited from signal ${signal}${suffix ? `: ${suffix}` : ''}`;
  return `Codex App Server exited with code ${code ?? 'unknown'}${suffix ? `: ${suffix}` : ''}`;
}

export class AppServerClient {
  constructor({
    codexPath = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    timeoutMs = 15_000,
    idPrefix = `csr-${process.pid}-${randomUUID()}`,
    spawnImpl = spawn,
    clientInfo = {
      name: 'codex_smart_router',
      title: 'Codex Smart Router',
      version: '0.2.0',
    },
    onNotification = null,
  } = {}) {
    this.codexPath = codexPath;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.idPrefix = idPrefix;
    this.spawnImpl = spawnImpl;
    this.clientInfo = clientInfo;
    this.onNotification = onNotification;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.startPromise = null;
    this.closed = false;
    this.stderr = '';
    this.initializeResult = null;
  }

  async start() {
    if (this.closed) throw new Error('Codex App Server client is closed');
    if (!this.startPromise) this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    const child = this.spawnImpl(this.codexPath, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let pendingText = '';

    child.stdout.on('data', (chunk) => {
      pendingText += decoder.write(chunk);
      for (;;) {
        const newline = pendingText.indexOf('\n');
        if (newline < 0) break;
        const line = pendingText.slice(0, newline).replace(/\r$/, '');
        pendingText = pendingText.slice(newline + 1);
        if (line) this.#receive(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-20_000);
    });
    child.once('error', (error) => this.#failAll(error));
    child.once('exit', (code, signal) => {
      const finalText = `${pendingText}${decoder.end()}`.trim();
      if (finalText) this.#receive(finalText);
      this.#failAll(new Error(exitDescription(code, signal, this.stderr)));
      this.child = null;
    });

    this.initializeResult = await this.#requestStarted('initialize', { clientInfo: this.clientInfo });
    this.notify('initialized', {});
    return this.initializeResult;
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#failAll(new Error('Codex App Server returned invalid JSON'));
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`Codex App Server ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && this.onNotification) this.onNotification(message);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #requestStarted(method, params = {}) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex App Server stdin is unavailable'));
    const id = `${this.idPrefix}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async request(method, params = {}) {
    await this.start();
    return this.#requestStarted(method, params);
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server stdin is unavailable');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async account() {
    return this.request('account/read', { refreshToken: false });
  }

  async listModels({ limit = 100, includeHidden = true } = {}) {
    const models = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      const result = await this.request('model/list', { cursor, limit, includeHidden });
      if (!result || !Array.isArray(result.data)) throw new Error('Codex App Server returned an invalid model/list page');
      models.push(...result.data);
      cursor = result.nextCursor ?? null;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) throw new Error(`Codex App Server repeated model/list cursor: ${cursor}`);
        seenCursors.add(cursor);
      }
    } while (cursor !== null);
    return models;
  }

  async close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    this.#failAll(new Error('Codex App Server client closed'));
    if (child.stdin?.writable) child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
  }
}
