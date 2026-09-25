// Unit tests for the pure dedupe/filter decision in the outpost ntfy example
// receiver. The receiver itself is a standalone script (createServer,
// process.exit, env-var reading) with no existing test harness, so this
// covers only the extracted pure functions it exports — shouldForward,
// itemKey, parseSeenLine, and loadSeenState — none of which touch the
// filesystem or the network. Importing the module does not start the server:
// receiver.mjs guards its side-effecting main() behind a direct-execution
// check (see the bottom of the file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import {
  itemKey,
  parseSeenLine,
  loadSeenState,
  shouldForward,
  isAuthorized,
  createReceiverHandler,
} from '../examples/outpost-ntfy-receiver/receiver.mjs';

function signedHeaders(id, timestamp, body, secret) {
  const signature = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
}

test('receiver authorization accepts only the exact Standard Webhooks signature when a secret is configured', () => {
  const body = '{"title":"snowman ☃"}';
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = signedHeaders(id, timestamp, body, 'Jefe');

  assert.equal(isAuthorized({ headers }, body, 'Jefe'), true);
  assert.equal(isAuthorized({ headers: {} }, body, 'Jefe'), false);
  assert.equal(
    isAuthorized(
      { headers: { ...headers, 'webhook-signature': 'v1,bm90LWJhc2U2NA==' } },
      body,
      'Jefe',
    ),
    false,
  );
  assert.equal(
    isAuthorized({ headers }, '{"title":"changed"}', 'Jefe'),
    false,
    'a mutated body must not verify against a signature computed over the original bytes',
  );
});

test('receiver rejects a webhook-timestamp more than 5 minutes from now, even with a valid signature', () => {
  const body = '{"title":"snowman ☃"}';
  const id = 'msg_1';
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
  const headers = signedHeaders(id, staleTimestamp, body, 'Jefe');
  assert.equal(isAuthorized({ headers }, body, 'Jefe'), false);

  const futureTimestamp = String(Math.floor(Date.now() / 1000) + 6 * 60);
  const futureHeaders = signedHeaders(id, futureTimestamp, body, 'Jefe');
  assert.equal(isAuthorized({ headers: futureHeaders }, body, 'Jefe'), false);

  const freshTimestamp = String(Math.floor(Date.now() / 1000) - 60);
  const freshHeaders = signedHeaders(id, freshTimestamp, body, 'Jefe');
  assert.equal(isAuthorized({ headers: freshHeaders }, body, 'Jefe'), true);
});

test('receiver rejects unsigned requests before parsing or recording and accepts a correctly signed request', async (t) => {
  const seen = new Map();
  let records = 0;
  let forwards = 0;
  const server = createServer(
    createReceiverHandler({
      outpostSecret: 'Jefe',
      classes: [],
      seen,
      recordSeen: (key, id) => {
        records++;
        seen.set(key, id);
      },
      forward: async () => {
        forwards++;
      },
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  const body = JSON.stringify({
    type: 'gh-delta.delta',
    schemaVersion: 2,
    deliveryId: 'gh-delta.delivery.v1:o/r:m:pr:1:merged:2026-07-01T12:00:00.000Z',
    seq: null,
    monitorId: 'm',
    detectedAt: '2026-07-01T12:00:00.000Z',
    delta: { id: 'sha', repo: 'o/r', entity: 'pr', number: 1, classes: ['merged'] },
  });
  const request = (headers = {}, requestBody = body) =>
    globalThis.fetch(url, { method: 'POST', headers, body: requestBody });

  assert.equal((await request()).status, 401);
  assert.equal(
    (
      await request({
        'webhook-id': 'x',
        'webhook-timestamp': 'not-a-number',
        'webhook-signature': 'v1,bad',
      })
    ).status,
    401,
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal(
    (
      await request({
        'webhook-id': 'x',
        'webhook-timestamp': timestamp,
        'webhook-signature': 'v1,' + Buffer.alloc(32).toString('base64'),
      })
    ).status,
    401,
  );
  assert.equal(records, 0);
  assert.equal(forwards, 0);
  assert.equal(seen.size, 0);

  const headers = signedHeaders('x', timestamp, body, 'Jefe');
  assert.equal((await request(headers)).status, 202);
  assert.equal(records, 1);
  assert.equal(forwards, 1);
  assert.deepEqual([...seen], [['pr#1', 'sha']]);
});

test('receiver rejects an oversized chunked body before parsing, recording, or forwarding', async (t) => {
  const seen = new Map();
  let records = 0;
  let forwards = 0;
  const server = createServer(
    createReceiverHandler({
      outpostSecret: 'Jefe',
      classes: [],
      seen,
      recordSeen: () => {
        records++;
      },
      forward: async () => {
        forwards++;
      },
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const body = 'x'.repeat(64 * 1024 + 1);

  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 1024));
    req.end(body.slice(1024));
  });

  assert.equal(status, 413);
  assert.equal(records, 0);
  assert.equal(forwards, 0);
  assert.equal(seen.size, 0);
});

function payload({ number = 42, id, classes = ['ci-changed'] } = {}) {
  return {
    type: 'gh-delta.delta',
    schemaVersion: 2,
    deliveryId: 'gh-delta.delivery.v1:o/r:m:pr:42:ci-changed:2026-07-01T12:00:00.000Z',
    seq: null,
    monitorId: 'm',
    detectedAt: '2026-07-01T12:00:00.000Z',
    delta: { id, entity: 'pr', number, classes },
  };
}

test('red -> green -> red with all other fingerprint fields equal forwards all three', () => {
  const seen = new Map();
  const ids = ['sha-red', 'sha-green', 'sha-red']; // id repeats: same observed state recurs
  const forwarded = [];
  for (const id of ids) {
    const decision = shouldForward(seen, payload({ id }), []);
    if (decision.action === 'forward') {
      seen.set(decision.key, id);
      forwarded.push(id);
    }
  }
  assert.deepEqual(forwarded, ids, 'every delivery must forward, including the id repeat');
});

test('the same id arriving twice in a row for one item forwards once', () => {
  const seen = new Map();
  const first = shouldForward(seen, payload({ id: 'sha-a' }), []);
  assert.equal(first.action, 'forward');
  seen.set(first.key, 'sha-a');

  const second = shouldForward(seen, payload({ id: 'sha-a' }), []);
  assert.equal(second.action, 'deduped');
});

test('the same id for two different items is not cross-suppressed', () => {
  const seen = new Map();
  const a = shouldForward(seen, payload({ number: 1, id: 'sha-shared' }), []);
  assert.equal(a.action, 'forward');
  seen.set(a.key, 'sha-shared');

  const b = shouldForward(seen, payload({ number: 2, id: 'sha-shared' }), []);
  assert.equal(b.action, 'forward', 'a different (entity, number) must not be suppressed');
  assert.notEqual(a.key, b.key);
});

test('a payload filtered out by NTFY_CLASSES does not suppress a later payload with the same id and an allowed class', () => {
  const seen = new Map();
  const filtered = shouldForward(seen, payload({ id: 'sha-x', classes: ['new-comments'] }), [
    'ci-changed',
  ]);
  assert.equal(filtered.action, 'filtered');
  assert.equal(filtered.key, null, 'a filtered payload must not carry a key to record');
  // Simulate the receiver: only forwarded payloads get recordSeen called, so
  // `seen` stays empty here.
  assert.equal(seen.size, 0);

  const allowed = shouldForward(seen, payload({ id: 'sha-x', classes: ['ci-changed'] }), [
    'ci-changed',
  ]);
  assert.equal(
    allowed.action,
    'forward',
    'the same id with an allowed class must still forward after an earlier filtered delivery',
  );
});

test('itemKey scopes on (entity, number)', () => {
  assert.equal(itemKey({ delta: { entity: 'pr', number: 42 } }), 'pr#42');
  assert.equal(itemKey({ delta: { entity: 'issue', number: 42 } }), 'issue#42');
});

test('old-format seen-file lines are skipped without crashing', () => {
  const text = [
    '{"eventId":"gh-delta.delta.v1:owner/repo:mon:pr:1:new","at":"2026-01-01T00:00:00.000Z"}', // pre-branch format
    '{"id":"deadbeef","at":"2026-01-02T00:00:00.000Z"}', // mid-review format, no key
    'not even json',
    '',
    '{"key":"pr#7","id":"sha-good","at":"2026-01-03T00:00:00.000Z"}', // current format
  ].join('\n');

  const { seen, seenOrder } = loadSeenState(text);
  assert.deepEqual([...seen.entries()], [['pr#7', 'sha-good']]);
  assert.deepEqual(seenOrder, ['pr#7']);
});

test('loadSeenState replays multiple lines for the same key with last-line-wins', () => {
  const text = [
    '{"key":"pr#7","id":"sha-1","at":"2026-01-01T00:00:00.000Z"}',
    '{"key":"pr#7","id":"sha-2","at":"2026-01-02T00:00:00.000Z"}',
  ].join('\n');

  const { seen, seenOrder } = loadSeenState(text);
  assert.equal(seen.get('pr#7'), 'sha-2');
  assert.deepEqual(seenOrder, ['pr#7'], 'a repeated key must not duplicate its slot in seenOrder');
});

test('parseSeenLine skips lines missing key or id', () => {
  assert.equal(parseSeenLine(''), null);
  assert.equal(parseSeenLine('garbage'), null);
  assert.equal(parseSeenLine('{"eventId":"x"}'), null);
  assert.equal(parseSeenLine('{"id":"x"}'), null);
  assert.deepEqual(parseSeenLine('{"key":"pr#1","id":"x"}'), { key: 'pr#1', id: 'x' });
});
