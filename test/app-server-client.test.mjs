import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AppServerClient } from '../src/app-server-client.mjs';

function fakeProcess(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
  };
  let pending = '';
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      handler(JSON.parse(line), (message, fragments = null) => {
        const encoded = `${JSON.stringify(message)}\n`;
        if (!fragments) child.stdout.write(encoded);
        else {
          let offset = 0;
          for (const length of fragments) {
            child.stdout.write(Buffer.from(encoded).subarray(offset, offset + length));
            offset += length;
          }
          child.stdout.write(Buffer.from(encoded).subarray(offset));
        }
      });
    }
  });
  return child;
}

test('initializes once and follows every model/list cursor with private IDs', async () => {
  const requests = [];
  const pages = new Map([
    [null, { data: [{ id: 'one', model: 'm-one' }], nextCursor: 'next' }],
    ['next', { data: [{ id: 'two', model: 'm-two' }], nextCursor: null }],
  ]);
  const client = new AppServerClient({
    timeoutMs: 100,
    idPrefix: 'csr-test',
    spawnImpl() {
      return fakeProcess((request, reply) => {
        requests.push(request);
        if (request.method === 'initialize') reply({ id: request.id, result: { userAgent: 'codex/1.2.3' } }, [1, 2, 3]);
        if (request.method === 'model/list') reply({ id: request.id, result: pages.get(request.params.cursor ?? null) });
      });
    },
  });

  const [first, second] = await Promise.all([
    client.listModels({ limit: 1 }),
    client.listModels({ limit: 1 }),
  ]);

  assert.deepEqual(first.map((model) => model.model), ['m-one', 'm-two']);
  assert.deepEqual(second.map((model) => model.model), ['m-one', 'm-two']);
  assert.equal(requests.filter((request) => request.method === 'initialize').length, 1);
  assert.equal(requests.filter((request) => request.method === 'initialized').length, 1);
  assert.ok(requests.filter((request) => request.id).every((request) => String(request.id).startsWith('csr-test:')));
  await client.close();
});

test('rejects a request when the App Server does not respond before its timeout', async () => {
  const client = new AppServerClient({
    timeoutMs: 10,
    spawnImpl() {
      return fakeProcess((request, reply) => {
        if (request.method === 'initialize') reply({ id: request.id, result: { userAgent: 'codex/test' } });
      });
    },
  });

  await assert.rejects(() => client.listModels(), /timed out.*model\/list/i);
  await client.close();
});

test('rejects all pending requests when the child process exits', async () => {
  let child;
  const client = new AppServerClient({
    timeoutMs: 100,
    spawnImpl() {
      child = fakeProcess((request, reply) => {
        if (request.method === 'initialize') reply({ id: request.id, result: { userAgent: 'codex/test' } });
        if (request.method === 'model/list') queueMicrotask(() => child.emit('exit', 9, null));
      });
      return child;
    },
  });

  await assert.rejects(() => client.listModels(), /exited with code 9/i);
});
