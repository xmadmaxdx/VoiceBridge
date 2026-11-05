'use strict';

const http = require('http');
const { timingSafeEqual } = require('crypto');
const { WebSocketServer } = require('ws');
const { parseEnvelope, sanitizeText } = require('./protocol');

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 20000;

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function createServer({ hub, token, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return send(res, 400, { error: 'bad_url' });
    }

    const headerToken = req.headers['x-vb-token'];
    const queryToken = url.searchParams.get('token');
    const authed = tokenMatches(headerToken, token) || tokenMatches(queryToken, token);

    if (url.pathname === '/api/health' && !authed) {
      // Liveness only: no state, no token oracle.
      return send(res, 200, { ok: true, service: 'voicebridge' });
    }
    if (!authed) return send(res, 401, { error: 'unauthorized' });
    if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
      return send(res, 204, {});
    }

    try {
      if (url.pathname === '/api/health') {
        return send(res, 200, { ok: true, service: 'voicebridge', phone: hub.phoneConnected });
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, hub.snapshot());
      }

      if (url.pathname === '/api/transcript' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        return send(res, 200, { transcript: hub.transcript.slice(-limit) });
      }

      if (url.pathname === '/api/say' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await hub.speak(body.text, body.priority);
        return send(res, result.ok ? 200 : 409, result);
      }

      if (url.pathname === '/api/status' && req.method === 'POST') {
        const body = await readBody(req);
        const status = hub.setStatus({ state: body.state, detail: body.detail });
        return send(res, 200, { ok: true, status });
      }

      if (url.pathname === '/api/ask' && req.method === 'POST') {
        const body = await readBody(req);
        const timeoutMs = Math.min(Number(body.timeout_seconds) * 1000 || 0, 600000);
        const result = await hub.ask({
          question: body.question,
          timeoutMs: timeoutMs || undefined,
        });
        return send(res, 200, result);
      }

      if (url.pathname === '/api/inbox/drain' && req.method === 'POST') {
        return send(res, 200, { messages: hub.drainInbox() });
      }

      if (url.pathname === '/api/inbox/wait' && req.method === 'POST') {
        // Long-poll: returns the moment the phone says something, so the agent
        // can receive an instruction inside its current turn instead of on the
        // next one.
        const body = await readBody(req);
        const timeoutMs = Math.min(Math.max(Number(body.timeout_seconds) * 1000 || 120000, 1000), 600000);
        const existing = hub.drainInbox();
        if (existing.length) return send(res, 200, { messages: existing, waitedMs: 0 });

        const started = Date.now();
        const messages = await new Promise((resolve) => {
          const onUtterance = () => {
            const drained = hub.drainInbox();
            if (!drained.length) return;
            clearTimeout(timer);
            hub.off('utterance', onUtterance);
            resolve(drained);
          };
          const timer = setTimeout(() => {
            hub.off('utterance', onUtterance);
            resolve([]);
          }, timeoutMs);
          if (timer.unref) timer.unref();
          hub.on('utterance', onUtterance);
        });
        return send(res, 200, { messages, waitedMs: Date.now() - started });
      }

      if (url.pathname === '/api/inject' && req.method === 'POST') {
        // Manual path, used by `vb type` for testing without speech.
        const body = await readBody(req);
        const text = sanitizeText(body.text);
        if (!text) return send(res, 400, { error: 'empty_text' });
        const record = hub.acceptUtterance({
          id: 'manual', type: 'speech', payload: { text },
        });
        if (!record) return send(res, 400, { ok: false, error: 'empty_text' });
        return send(res, 200, {
          ok: true,
          messageId: record.id,
          status: record.status,
          route: record.route,
        });
      }

      return send(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      log('api_error', `${req.method} ${url.pathname}: ${err.message}`);
      return send(res, err.status || 500, { error: err.message });
    }
  });

  // ask_user holds a request open for up to 10 minutes; do not kill it.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!tokenMatches(url.searchParams.get('token'), token)) {
      ws.close(4401, 'unauthorized');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      const parsed = parseEnvelope(raw.toString());
      if (!parsed.ok) {
        ws.send(JSON.stringify({
          v: 1, id: 'error', type: 'error', ts: Date.now(),
          payload: { code: parsed.error, got: parsed.got || null },
        }));
        return;
      }
      const msg = parsed.value;
      if (msg.type === 'hello') {
        hub.attachPhone(ws, msg.payload);
        return;
      }
      if (!hub.phoneConnected) hub.attachPhone(ws, {});
      hub.handlePhoneMessage(msg);
    });

    ws.on('close', () => {
      if (hub.phone === ws) hub.detachPhone();
    });

    ws.on('error', (err) => log('ws_error', err.message));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  return {
    server,
    wss,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'server_shutdown');
        } catch {
          // ignore
        }
      }
      wss.close();
      server.close();
    },
  };
}

module.exports = { createServer, tokenMatches };
