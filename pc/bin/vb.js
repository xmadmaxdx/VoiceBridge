#!/usr/bin/env node
'use strict';

/**
 * VoiceBridge CLI. This is the whole agent-facing surface: the agent calls it
 * through its normal shell tool, so no MCP registration and no extra tool
 * traffic is needed. AGENTS.md tells the agent when to call it.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PC_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.VOICEBRIDGE_DATA || path.join(PC_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.jsonl');

const { LineStore } = require(path.join(PC_ROOT, 'lib', 'store.js'));
const { Hub } = require(path.join(PC_ROOT, 'lib', 'hub.js'));
const { createServer } = require(path.join(PC_ROOT, 'lib', 'server.js'));
const { Injector } = require(path.join(PC_ROOT, 'lib', 'injector.js'));

function loadConfig({ create = true } = {}) {
  const cfg = { port: 8765, host: '127.0.0.1', inject: { mode: 'off', title: '' } };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    // first run
  }
  if (!cfg.token && create) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
  if (process.env.VOICEBRIDGE_TOKEN) cfg.token = process.env.VOICEBRIDGE_TOKEN;
  if (process.env.VOICEBRIDGE_PORT) cfg.port = Number(process.env.VOICEBRIDGE_PORT);
  if (process.env.VOICEBRIDGE_HOST) cfg.host = process.env.VOICEBRIDGE_HOST;
  return cfg;
}

function api(cfg, pathname, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: cfg.host,
      port: cfg.port,
      path: pathname,
      method: payload === null ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vb-token': cfg.token || '',
        ...(payload === null ? {} : { 'content-length': Buffer.byteLength(payload) }),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = { error: 'bad_json', raw };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return fallback;
  return args[i + 1];
}

function stripFlags(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (names.includes(args[i])) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Pending phone instructions, printed only when they exist. Never blank. */
async function printInbox(cfg) {
  try {
    const { json } = await api(cfg, '/api/inbox/drain', {}, 4000);
    const messages = Array.isArray(json.messages) ? json.messages : [];
    if (!messages.length) return;
    process.stdout.write('\nPENDING_INSTRUCTIONS (spoken on the phone):\n');
    messages.forEach((m, i) => process.stdout.write(`${i + 1}. ${m.text}\n`));
    process.stdout.write('Act on these before continuing.\n');
  } catch {
    // bridge down; nothing to add
  }
}

function portFree(cfg) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: cfg.host, port: cfg.port });
    socket.setTimeout(700);
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(true));
  });
}

// ------------------------------------------------------------------ commands

async function cmdSay(cfg, args) {
  const priority = flag(args, '--priority', 'normal');
  const words = stripFlags(args, ['--priority']);
  const text = words.join(' ').trim();
  if (!text) {
    process.stderr.write('usage: vb say "<text>" [--priority high]\n');
    return 2;
  }
  try {
    const { json } = await api(cfg, '/api/say', { text, priority });
    if (json.ok) {
      process.stdout.write(`spoken: ${text}\n`);
    } else {
      process.stdout.write(`not_spoken: ${json.error || 'unknown'}\n`);
      process.stdout.write('The phone is not connected. Continue working and mention it at the end.\n');
    }
    await printInbox(cfg);
    return json.ok ? 0 : 4;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    process.stderr.write('Start it with: node pc/bin/vb.js start --wrap freebuff\n');
    return 1;
  }
}

async function cmdAsk(cfg, args) {
  const timeoutSeconds = Number(flag(args, '--timeout', '120'));
  const question = stripFlags(args, ['--timeout']).join(' ').trim();
  if (!question) {
    process.stderr.write('usage: vb ask "<question>" [--timeout seconds]\n');
    return 2;
  }
  process.stdout.write(`asking: ${question}\n`);
  try {
    const { json } = await api(cfg, '/api/ask', { question, timeout_seconds: timeoutSeconds }, (timeoutSeconds + 25) * 1000);
    if (json.ok && json.answer) {
      process.stdout.write(`ANSWER: ${json.answer}\n`);
      return 0;
    }
    const reason = json.error || 'no_answer';
    process.stdout.write(`NO_ANSWER: ${reason}\n`);
    if (reason === 'phone_not_connected') {
      process.stdout.write('Nobody is listening. Decide yourself and say what you chose.\n');
    } else if (reason === 'timeout') {
      process.stdout.write('Timed out. Decide yourself and say what you chose.\n');
    }
    await printInbox(cfg);
    return reason === 'timeout' ? 3 : 4;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    return 1;
  }
}

async function cmdStatus(cfg, args) {
  const state = (args[0] || 'working').toLowerCase();
  const detail = args.slice(1).join(' ').trim();
  try {
    const { json, status } = await api(cfg, '/api/status', { state, detail }, 6000);
    if (status !== 200) {
      process.stdout.write(`status_rejected: ${json.error || status}\n`);
      return 2;
    }
    process.stdout.write(`status: ${json.status.state}${detail ? ` (${detail})` : ''}\n`);
    await printInbox(cfg);
    return 0;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    return 1;
  }
}

async function cmdInbox(cfg, args = []) {
  const waitSeconds = Number(flag(args, '--wait', '0'));
  if (waitSeconds > 0) {
    process.stdout.write(`waiting up to ${waitSeconds}s for the phone...\n`);
    try {
      const { json } = await api(cfg, '/api/inbox/wait',
        { timeout_seconds: waitSeconds }, (waitSeconds + 20) * 1000);
      const messages = json.messages || [];
      if (!messages.length) {
        process.stdout.write('inbox: nothing arrived\n');
        return 3;
      }
      messages.forEach((m) => process.stdout.write(`- ${m.text}\n`));
      return 0;
    } catch (err) {
      process.stderr.write(`bridge_unreachable: ${err.message}\n`);
      return 1;
    }
  }
  try {
    const { json } = await api(cfg, '/api/inbox/drain', {});
    const messages = json.messages || [];
    if (!messages.length) {
      process.stdout.write('inbox: empty\n');
      return 0;
    }
    messages.forEach((m) => process.stdout.write(`- ${m.text}\n`));
    return 0;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    return 1;
  }
}

async function cmdState(cfg) {
  try {
    const { json } = await api(cfg, '/api/state');
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    return 1;
  }
}

async function cmdType(cfg, args) {
  const text = args.join(' ').trim();
  if (!text) {
    process.stderr.write('usage: vb type "<text>"\n');
    return 2;
  }
  try {
    const { json } = await api(cfg, '/api/inject', { text });
    process.stdout.write(`${JSON.stringify(json)}\n`);
    return json.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`bridge_unreachable: ${err.message}\n`);
    return 1;
  }
}

async function cmdDoctor(cfg) {
  const lines = [];
  const ok = (label, detail) => lines.push(`  [ok]   ${label}${detail ? `: ${detail}` : ''}`);
  const warn = (label, detail) => lines.push(`  [warn] ${label}${detail ? `: ${detail}` : ''}`);
  const bad = (label, detail) => lines.push(`  [fail] ${label}${detail ? `: ${detail}` : ''}`);

  lines.push('VoiceBridge doctor');
  lines.push(`  node: ${process.version}`);

  const wsVersion = (() => {
    try {
      return require(path.join(PC_ROOT, 'node_modules', 'ws', 'package.json')).version;
    } catch {
      return null;
    }
  })();
  wsVersion ? ok('ws', wsVersion) : bad('ws', 'not installed, run npm install in pc/');

  let pty = null;
  try {
    require(path.join(PC_ROOT, 'node_modules', 'node-pty'));
    pty = require(path.join(PC_ROOT, 'node_modules', 'node-pty', 'package.json')).version;
  } catch {
    pty = null;
  }
  pty ? ok('node-pty', `${pty} (real terminal injection)`) : warn('node-pty', 'missing, falls back to stdin pipe');

  lines.push(`  token: ${cfg.token ? `${cfg.token.slice(0, 6)}... (${CONFIG_FILE})` : 'none'}`);
  const free = await portFree(cfg);
  free ? ok('port', `${cfg.host}:${cfg.port} is free (bridge not running)`) : ok('port', `${cfg.host}:${cfg.port} in use (bridge running or other app)`);

  try {
    const { json } = await api(cfg, '/api/health', undefined, 1500);
    ok('bridge', `running, phone ${json.phone ? 'connected' : 'not connected'}`);
  } catch {
    warn('bridge', 'not running');
  }

  const adb = await new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('adb', ['devices'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const devices = stdout.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
      resolve(devices);
    });
  });
  if (!adb) bad('adb', 'not found on PATH');
  else if (!adb.length) warn('adb', 'no device attached (plug in USB, allow debugging)');
  else ok('adb', adb.join(', '));

  lines.push('');
  lines.push('Next: node pc/bin/vb.js start --wrap freebuff');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function cmdWindows() {
  try {
    const { listWindows } = require(path.join(PC_ROOT, 'lib', 'win-inject.js'));
    const wins = listWindows();
    if (!wins.length) {
      process.stdout.write('no visible windows\n');
      return 0;
    }
    wins.forEach((w) => process.stdout.write(`${w.handle}\t${w.pid}\t${w.title}\n`));
    process.stdout.write('\nSet the terminal that runs freebuff in pc/data/config.json:\n');
    process.stdout.write('  "inject": { "mode": "window", "title": "<part of that title>" }\n');
    process.stdout.write('Then restart the bridge without --wrap.\n');
    return 0;
  } catch (err) {
    process.stderr.write(`windows: ${err.message}\n`);
    return 1;
  }
}

// --------------------------------------------------------------------- serve

async function cmdStart(cfg, args) {
  const wrapIndex = args.indexOf('--wrap');
  const dashIndex = args.indexOf('--');
  let command = null;
  let commandArgs = [];

  if (wrapIndex !== -1) {
    command = args[wrapIndex + 1];
    commandArgs = args.slice(wrapIndex + 2);
  } else if (dashIndex !== -1) {
    command = args[dashIndex + 1];
    commandArgs = args.slice(dashIndex + 2);
  }

  const store = new LineStore(QUEUE_FILE);
  store.load();
  const hub = new Hub({
    store,
    log: (event, detail) => process.stderr.write(`[vb] ${event}${detail ? `: ${detail}` : ''}\n`),
  });

  let injector = null;
  if (command) {
    injector = new Injector({
      command,
      args: commandArgs,
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
    }, {
      onData: (data) => process.stdout.write(data),
      onExit: ({ code }) => {
        shutdown(code === undefined ? 0 : code);
      },
    });
    try {
      injector.start();
      hub.injector = injector;
    } catch (err) {
      process.stderr.write(`[vb] failed to start ${command}: ${err.message}\n`);
      return 1;
    }
  } else if (cfg.inject && cfg.inject.mode === 'window' && cfg.inject.title) {
    try {
      const { WindowInjector } = require(path.join(PC_ROOT, 'lib', 'win-inject.js'));
      injector = new WindowInjector({
        title: cfg.inject.title,
        stealFocus: Boolean(cfg.inject.stealFocus),
        restoreFocus: cfg.inject.restoreFocus !== false,
      });
      hub.injector = injector;
    } catch (err) {
      process.stderr.write(`[vb] window injector unavailable: ${err.message}\n`);
    }
  }

  const bridge = createServer({ hub, token: cfg.token, log: (e, d) => process.stderr.write(`[vb] ${e}: ${d}\n`) });

  let shuttingDown = false;
  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (injector) injector.stop();
    } catch {
      // ignore
    }
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    try {
      bridge.close();
    } catch {
      // ignore
    }
    process.exit(code);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
  });

  try {
    await bridge.listen(cfg.port, cfg.host);
  } catch (err) {
    process.stderr.write(`[vb] cannot listen on ${cfg.host}:${cfg.port}: ${err.message}\n`);
    process.stderr.write('[vb] is another bridge already running?\n');
    if (injector) injector.stop();
    return 1;
  }

  process.stderr.write(`[vb] bridge ws://${cfg.host}:${cfg.port}/ws\n`);
  process.stderr.write(`[vb] injector: ${injector ? injector.mode : 'none (messages park in the queue)'}\n`);
  process.stderr.write('[vb] phone: adb reverse tcp:' + cfg.port + ' tcp:' + cfg.port + ' then open the app\n');

  if (injector) {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // ignore
      }
    }
    process.stdin.resume();
    process.stdin.on('data', (chunk) => injector.writeRaw(chunk.toString()));
    process.stdout.on('resize', () => {
      injector.resize(process.stdout.columns, process.stdout.rows);
    });
  }

  return new Promise(() => {});
}

// ---------------------------------------------------------------------- main

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write([
      'VoiceBridge - phone as microphone and speaker for the coding agent',
      '',
      '  vb start --wrap freebuff     run the bridge and type voice into freebuff',
      '  vb windows                   list windows that can receive typed voice',
      '  vb serve                     bridge only, messages wait in the queue',
      '  vb say "<text>"              speak on the phone',
      '  vb ask "<question>"          ask on the phone and print the answer',
      '  vb status <state> [detail]   thinking|working|waiting|speaking|completed|failed',
      '  vb inbox                     print queued phone instructions',
      '  vb inbox --wait 120          block until the phone speaks, then print it',
      '  vb type "<text>"             simulate a phone message (testing)',
      '  vb state                     JSON snapshot of the bridge',
      '  vb doctor                    check node, pty, adb, port, bridge',
      '  vb token                     print the connection token',
      '',
      'Exit codes: 0 ok, 1 bridge unreachable, 2 bad usage, 3 no answer (timeout), 4 no phone',
    ].join('\n') + '\n');
    return 0;
  }

  if (command === 'token') {
    const cfg = loadConfig();
    process.stdout.write(`${cfg.token}\n`);
    return 0;
  }

  const cfg = loadConfig();

  switch (command) {
    case 'say': return cmdSay(cfg, rest);
    case 'ask': return cmdAsk(cfg, rest);
    case 'status': return cmdStatus(cfg, rest);
    case 'inbox': return cmdInbox(cfg, rest);
    case 'type': return cmdType(cfg, rest);
    case 'state': return cmdState(cfg);
    case 'windows': return cmdWindows();
    case 'doctor': return cmdDoctor(cfg);
    case 'start':
    case 'serve': return cmdStart(cfg, command === 'serve' ? [] : rest);
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.stdout.write('run "vb help" for the command list\n');
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    // start/serve never resolve; everything else exits here.
    process.exit(typeof code === 'number' ? code : 0);
  })
  .catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
