'use strict';

const { EventEmitter } = require('events');
const { envelope, newId, sanitizeText } = require('./protocol');

const DEFAULT_ASK_TIMEOUT_MS = 120000;
const MAX_ASK_TIMEOUT_MS = 600000;
const TRANSCRIPT_LIMIT = 200;
const OUTBOUND_LIMIT = 500;

const VALID_STATES = new Set([
  'idle', 'thinking', 'working', 'waiting', 'speaking', 'completed', 'failed',
]);

class Hub extends EventEmitter {
  constructor({ store, log = () => {} } = {}) {
    super();
    this.store = store;
    this.log = log;
    this.phone = null;
    this.phoneInfo = null;
    this.injector = null;
    this.sessionId = newId('sess');
    this.status = { state: 'idle', detail: '', ts: Date.now() };
    this.transcript = [];
    this.pendingAsk = null;
    this.outbound = new Map();
    this.phoneState = { mic: 'idle', speaking: false, ts: Date.now() };
    this.stats = { utterances: 0, injected: 0, queued: 0, spoken: 0 };
  }

  // ---------------------------------------------------------------- phone io

  attachPhone(ws, hello = {}) {
    this.phone = ws;
    this.phoneInfo = {
      deviceName: sanitizeText(hello.deviceName || 'android', 64),
      appVersion: sanitizeText(hello.appVersion || 'unknown', 32),
      protocolVersion: hello.protocolVersion || null,
      connectedAt: Date.now(),
    };
    this.sendToPhone('hello_ok', {
      sessionId: this.sessionId,
      serverTime: Date.now(),
      status: this.status,
      injector: this.injector ? 'attached' : 'absent',
    });
    for (const line of this.transcript.slice(-30)) {
      this.sendToPhone('transcript', line);
    }
    this.emit('phone', { connected: true, info: this.phoneInfo });
  }

  detachPhone() {
    if (this.pendingAsk) this._settleAsk({ ok: false, error: 'phone_disconnected' });
    this.phone = null;
    this.phoneInfo = null;
    this.emit('phone', { connected: false });
  }

  get phoneConnected() {
    return Boolean(this.phone && this.phone.readyState === 1);
  }

  sendToPhone(type, payload = {}) {
    if (!this.phoneConnected) return null;
    const env = envelope(type, payload);
    try {
      this.phone.send(JSON.stringify(env));
    } catch (err) {
      this.log('send_failed', err.message);
      return null;
    }
    this.outbound.set(env.id, { type, sentAt: Date.now(), ackedAt: null });
    if (this.outbound.size > OUTBOUND_LIMIT) {
      const first = this.outbound.keys().next().value;
      this.outbound.delete(first);
    }
    return env.id;
  }

  // ------------------------------------------------------------ phone input

  handlePhoneMessage(msg) {
    switch (msg.type) {
      case 'hello':
        this.handleHelloAgain(msg);
        break;

      case 'ack': {
        const forId = msg.payload.forId;
        const rec = this.outbound.get(forId);
        if (rec) rec.ackedAt = Date.now();
        break;
      }

      case 'speech':
      case 'answer':
        this.acceptUtterance(msg);
        break;

      case 'interrupt':
        this.interrupt(msg.payload && msg.payload.reason);
        break;

      case 'state':
        this.phoneState = {
          mic: sanitizeText(msg.payload.mic || 'idle', 16),
          speaking: Boolean(msg.payload.speaking),
          ts: Date.now(),
        };
        break;

      case 'ping':
        this.sendToPhone('status', { ...this.status });
        break;

      case 'bye':
        this.detachPhone();
        break;

      default:
        this.sendToPhone('error', { code: 'unhandled_type', type: msg.type });
    }
  }

  handleHelloAgain(msg) {
    this.phoneInfo = { ...this.phoneInfo, ...msg.payload, reHelloAt: Date.now() };
    this.sendToPhone('hello_ok', {
      sessionId: this.sessionId,
      serverTime: Date.now(),
      status: this.status,
      injector: this.injector ? 'attached' : 'absent',
    });
  }

  acceptUtterance(msg) {
    const text = sanitizeText(msg.payload.text);
    if (!text) {
      this.sendToPhone('error', { code: 'empty_speech', forId: msg.id });
      return null;
    }

    const record = this.store.append({
      kind: 'utterance',
      id: newId('u'),
      text,
      ts: Date.now(),
      status: 'new',
      source: msg.type === 'answer' ? 'phone_answer' : 'phone_speech',
    });
    this.stats.utterances += 1;

    const route = this.deliver(record);
    // Emitted after routing so a waiter can never steal a message that the
    // question-answer path has already consumed.
    this.emit('utterance', record);
    this.sendToPhone('ack', {
      forId: msg.id,
      messageId: record.id,
      route: route.route,
    });
    return record;
  }

  /**
   * Single delivery channel, chosen at runtime so a message is never applied
   * twice:
   *   1. an open question  -> it IS the answer
   *   2. a TUI injector    -> typed into the live input box
   *   3. otherwise         -> parked in the queue, handed to the agent with
   *                           the next MCP tool result (piggyback)
   */
  deliver(record) {
    if (this.pendingAsk) {
      this.store.update(record.id, {
        status: 'delivered', route: 'ask_answer', deliveredAt: Date.now(),
      });
      this.pushTranscript('user', record.text);
      this._settleAsk({ ok: true, answer: record.text, messageId: record.id });
      return { route: 'ask_answer' };
    }

    if (this.injector) {
      const res = this.injector.submit(record.text);
      if (res.ok) {
        this.store.update(record.id, {
          status: 'delivered', route: 'tui_inject', deliveredAt: Date.now(), mode: res.mode,
        });
        this.stats.injected += 1;
        this.pushTranscript('user', record.text);
        return { route: 'tui_inject' };
      }
      this.store.update(record.id, {
        status: 'queued', route: 'inbox', injectorError: res.reason,
      });
      this.stats.queued += 1;
      this._noteQueued(res.reason);
      return { route: 'inbox', reason: res.reason };
    }

    this.store.update(record.id, { status: 'queued', route: 'inbox' });
    this.stats.queued += 1;
    this._noteQueued();
    return { route: 'inbox' };
  }

  /**
   * Tell the phone its words are parked, not typed. Without this the user
   * speaks, sees nothing change, and assumes the message vanished.
   */
  _noteQueued(reason) {
    const byReason = {
      window_not_focused: 'not sent — the Freebuff window is not focused on the PC. Click it, then speak again.',
      window_not_found: 'not sent — could not find the Freebuff window. Check inject.title in pc/data/config.json.',
      window_inject_failed: 'not sent — could not type into the window. The message is queued.',
      focus_failed: 'not sent — could not bring the Freebuff window forward. Bring it up once, then speak again.',
      refused_browser_window: 'not sent — that title matched a browser tab, not a terminal. Fix inject.title.',
      not_running: 'not sent — the wrapper process is gone. The message is queued.',
    };
    this.sendToPhone('transcript', {
      role: 'system',
      text: byReason[reason] || 'queued — no terminal attached, so the agent has not seen it yet',
    });
  }

  // ------------------------------------------------------------------ tools

  speak(text, priority = 'normal') {
    const clean = sanitizeText(text);
    if (!clean) return Promise.resolve({ ok: false, error: 'empty_text' });
    if (!this.phoneConnected) {
      return Promise.resolve({ ok: false, error: 'phone_not_connected' });
    }
    const utteranceId = this.sendToPhone('say', {
      text: clean, priority: priority === 'high' ? 'high' : 'normal',
    });
    this.stats.spoken += 1;
    this.pushTranscript('assistant', clean);
    return Promise.resolve({ ok: true, utteranceId });
  }

  setStatus({ state, detail = '' }) {
    const next = VALID_STATES.has(state) ? state : 'working';
    this.status = { state: next, detail: sanitizeText(detail, 200), ts: Date.now() };
    this.sendToPhone('status', { ...this.status });
    return this.status;
  }

  ask({ question, timeoutMs = DEFAULT_ASK_TIMEOUT_MS }) {
    const clean = sanitizeText(question);
    if (!clean) return Promise.resolve({ ok: false, error: 'empty_question' });
    if (!this.phoneConnected) {
      return Promise.resolve({ ok: false, error: 'phone_not_connected' });
    }
    const clamped = Math.min(Math.max(Number(timeoutMs) || DEFAULT_ASK_TIMEOUT_MS, 5000), MAX_ASK_TIMEOUT_MS);

    if (this.pendingAsk) this._settleAsk({ ok: false, error: 'superseded' });

    const askId = newId('ask');
    const timer = setTimeout(() => {
      this._settleAsk({ ok: false, error: 'timeout', askId });
    }, clamped);
    if (timer.unref) timer.unref();

    this.pendingAsk = { askId, question: clean, timer, startedAt: Date.now(), resolve: null };
    const promise = new Promise((resolve) => {
      this.pendingAsk.resolve = resolve;
    });

    this.setStatus({ state: 'waiting', detail: clean });
    this.pushTranscript('assistant', clean);
    this.sendToPhone('listen', { askId, question: clean, timeoutMs: clamped });
    return promise;
  }

  interrupt(reason = 'user_interrupt') {
    if (this.pendingAsk) {
      this._settleAsk({ ok: false, error: 'interrupted', reason });
      return { ok: true, cancelledAsk: true };
    }
    this.pushTranscript('system', 'interrupted');
    return { ok: true, cancelledAsk: false };
  }

  _settleAsk(result) {
    const pending = this.pendingAsk;
    if (!pending || !pending.resolve) {
      this.pendingAsk = null;
      return;
    }
    this.pendingAsk = null;
    clearTimeout(pending.timer);
    pending.resolve({ ...result, askId: pending.askId, question: pending.question });
    this.setStatus({ state: 'working' });
  }

  // -------------------------------------------------------------- piggyback

  /** Parked instructions waiting for the next tool result to carry them. */
  drainInbox(limit = 10) {
    const parked = this.store.byStatus('queued').slice(0, limit);
    const out = [];
    for (const rec of parked) {
      this.store.update(rec.id, { status: 'delivered', deliveredAt: Date.now(), route: 'piggyback' });
      this.pushTranscript('user', rec.text);
      out.push({ id: rec.id, text: rec.text, receivedAt: rec.ts });
    }
    return out;
  }

  pushTranscript(role, text) {
    const entry = { id: newId('t'), role, text: sanitizeText(text), ts: Date.now() };
    this.transcript.push(entry);
    if (this.transcript.length > TRANSCRIPT_LIMIT) {
      this.transcript = this.transcript.slice(-TRANSCRIPT_LIMIT);
    }
    this.emit('transcript', entry);
    return entry;
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      phone: this.phoneConnected ? this.phoneInfo : null,
      phoneState: this.phoneState,
      injector: this.injector ? 'attached' : 'absent',
      status: this.status,
      pendingAsk: this.pendingAsk
        ? { askId: this.pendingAsk.askId, question: this.pendingAsk.question, startedAt: this.pendingAsk.startedAt }
        : null,
      queued: this.store.byStatus('queued').length,
      stats: this.stats,
    };
  }
}

module.exports = {
  Hub,
  VALID_STATES,
  DEFAULT_ASK_TIMEOUT_MS,
  MAX_ASK_TIMEOUT_MS,
};
