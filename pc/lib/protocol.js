'use strict';

const PROTOCOL_VERSION = 1;
const MAX_TEXT = 4000;

const PHONE_TYPES = new Set([
  'hello', 'ack', 'speech', 'answer', 'interrupt', 'state', 'ping', 'bye',
]);

const HUB_TYPES = new Set([
  'hello_ok', 'say', 'listen', 'status', 'transcript', 'ack', 'error', 'ping', 'inbox',
]);

function newId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function envelope(type, payload = {}, extra = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: newId(),
    type,
    ts: Date.now(),
    payload: payload || {},
    ...extra,
  };
}

/**
 * Collapse to a single printable line. Required because the PC side types the
 * text into a terminal: a raw newline would submit the prompt early.
 */
function sanitizeText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseEnvelope(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'not_object' };
  }
  if (msg.v !== PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported_version', got: msg.v };
  }
  if (typeof msg.type !== 'string' || !PHONE_TYPES.has(msg.type)) {
    return { ok: false, error: 'unknown_type', got: msg.type };
  }
  const payload = (msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload))
    ? msg.payload
    : {};
  const id = typeof msg.id === 'string' && msg.id.length <= 120 ? msg.id : newId('anon');
  return { ok: true, value: { ...msg, id, payload } };
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_TEXT,
  PHONE_TYPES,
  HUB_TYPES,
  newId,
  envelope,
  sanitizeText,
  parseEnvelope,
};
