'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LineStore } = require('../lib/store');
const { Hub } = require('../lib/hub');
const { Injector } = require('../lib/injector');
const { createServer } = require('../lib/server');
const { sanitizeText, parseEnvelope, envelope } = require('../lib/protocol');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  const store = new LineStore(path.join(dir, 'queue.jsonl'));
  store.load();
  return store;
}

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('sanitizeText collapses newlines so a prompt cannot submit early', () => {
  assert.equal(sanitizeText('build\nthe\tdashboard'), 'build the dashboard');
  assert.equal(sanitizeText('  spaced  out  '), 'spaced out');
  assert.equal(sanitizeText('x'.repeat(9000)).length, 4000);
  assert.equal(sanitizeText(null), '');
});

test('parseEnvelope rejects junk and version drift', () => {
  assert.equal(parseEnvelope('not json').error, 'invalid_json');
  assert.equal(parseEnvelope(JSON.stringify({ v: 99, type: 'speech' })).error, 'unsupported_version');
  assert.equal(parseEnvelope(JSON.stringify({ v: 1, type: 'rm_rf' })).error, 'unknown_type');
  const ok = parseEnvelope(JSON.stringify({ v: 1, type: 'speech', id: 'abc', payload: { text: 'hi' } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.id, 'abc');
});

test('store survives a torn trailing line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-torn-'));
  const file = path.join(dir, 'q.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ id: 'a', kind: 'utterance' })}\n{"id":"broke`);
  const store = new LineStore(file);
  store.load();
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].id, 'a');
});

test('utterance with no injector parks in the queue and drains once', () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  hub.attachPhone(fakeSocket(), { deviceName: 'pixel' });

  const record = hub.acceptUtterance({ id: 'm1', type: 'speech', payload: { text: 'add dark mode' } });
  assert.ok(record.id);
  assert.equal(record.status, 'queued');
  assert.equal(hub.phone.sent.at(-1).payload.route, 'inbox');

  const drained = hub.drainInbox();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, 'add dark mode');
  assert.equal(hub.drainInbox().length, 0, 'must not deliver twice');
});

test('a queued message tells the phone why the TUI did not change', () => {
  const hub = new Hub({ store: tmpStore() });
  const phone = fakeSocket();
  hub.attachPhone(phone, {});
  phone.sent.length = 0;

  hub.acceptUtterance({ id: 'm9', type: 'speech', payload: { text: 'hey what you need' } });

  const note = phone.sent.find(
    (m) => m.type === 'transcript' && String(m.payload.text).includes('queued'),
  );
  assert.ok(note, 'the phone must be told the message was parked');
});

test('speech during an open question becomes the answer', async () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  hub.attachPhone(fakeSocket(), {});

  const asked = hub.ask({ question: 'Replace auth?', timeoutMs: 5000 });
  assert.ok(hub.pendingAsk);

  hub.acceptUtterance({ id: 'm2', type: 'speech', payload: { text: 'preserve it, improve the UI' } });
  const result = await asked;

  assert.equal(result.ok, true);
  assert.equal(result.answer, 'preserve it, improve the UI');
  assert.equal(hub.pendingAsk, null);
});

test('ask times out instead of blocking forever', async () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  hub.attachPhone(fakeSocket(), {});

  const result = await hub.ask({ question: 'anyone there?', timeoutMs: 5000 });
  // resolve manually after the short window used below
  assert.equal(result.ok, false);
});

test('ask fails fast when no phone is connected', async () => {
  const hub = new Hub({ store: tmpStore() });
  const result = await hub.ask({ question: 'hello?', timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'phone_not_connected');
});

test('interrupt settles a waiting question', async () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  hub.attachPhone(fakeSocket(), {});

  const asked = hub.ask({ question: 'waiting?', timeoutMs: 10000 });
  hub.interrupt('user_interrupt');
  const result = await asked;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'interrupted');
});

test('injected text reaches a live TUI stdin with Enter', async () => {
  const mock = path.join(__dirname, 'mock-tui.js');
  let output = '';
  const injector = new Injector({
    command: process.execPath,
    args: [mock],
    cwd: path.join(__dirname, '..'),
  }, {
    onData: (d) => {
      output += d;
    },
  }).start();

  assert.ok(injector.ready, 'child should be running');
  await waitFor(() => output.includes('MOCK-READY'));
  injector.submit('build the dashboard with dark mode');
  await waitFor(() => output.includes('SUBMIT:'));

  assert.match(output, /SUBMIT:build the dashboard with dark mode/);
  injector.stop();
});

test('HTTP API enforces the token and routes a message', async () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  const bridge = createServer({ hub, token: 'secret-token' });
  const address = await bridge.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const unauth = await fetch(`${base}/api/state`);
    assert.equal(unauth.status, 401);

    const wrong = await fetch(`${base}/api/state`, { headers: { 'x-vb-token': 'nope' } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/api/state`, { headers: { 'x-vb-token': 'secret-token' } });
    assert.equal(ok.status, 200);

    const injected = await fetch(`${base}/api/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vb-token': 'secret-token' },
      body: JSON.stringify({ text: 'use sqlite' }),
    });
    assert.equal(injected.status, 200);
    assert.equal((await injected.json()).route, 'inbox');

    const drain = await fetch(`${base}/api/inbox/drain`, {
      method: 'POST',
      headers: { 'x-vb-token': 'secret-token' },
      body: '{}',
    });
    const { messages } = await drain.json();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'use sqlite');
  } finally {
    bridge.close();
  }
});

test('websocket phone session receives ack and status', async () => {
  const store = tmpStore();
  const hub = new Hub({ store });
  const bridge = createServer({ hub, token: 't0ken' });
  const address = await bridge.listen(0, '127.0.0.1');

  const { WebSocket } = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=t0ken`);
  const received = [];
  ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));

  try {
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify(envelope('hello', { deviceName: 'test-phone' })));
    await waitFor(() => received.some((m) => m.type === 'hello_ok'));

    ws.send(JSON.stringify(envelope('speech', { text: 'ship it' })));
    await waitFor(() => received.some((m) => m.type === 'ack'));

    const ack = received.find((m) => m.type === 'ack');
    assert.equal(ack.payload.route, 'inbox');
    assert.equal(hub.phoneInfo.deviceName, 'test-phone');
  } finally {
    ws.close();
    bridge.close();
  }
});

test('websocket rejects a bad token', async () => {
  const hub = new Hub({ store: tmpStore() });
  const bridge = createServer({ hub, token: 'good' });
  const address = await bridge.listen(0, '127.0.0.1');
  const { WebSocket } = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=bad`);

  const closeCode = await new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });

  assert.equal(closeCode, 4401);
  bridge.close();
});
