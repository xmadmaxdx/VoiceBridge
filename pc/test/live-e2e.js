'use strict';

/**
 * Live end-to-end test with no mocks on the transport side:
 *   real `vb start` process -> real WebSocket -> real PTY -> real child stdin
 * Only the TUI is a stub (mock-tui.js), because we cannot drive the user's
 * actual terminal from here.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PC = path.resolve(__dirname, '..');
const PORT = 8791;
const TOKEN = 'live-e2e-token';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-live-'));

const env = {
  ...process.env,
  VOICEBRIDGE_PORT: String(PORT),
  VOICEBRIDGE_TOKEN: TOKEN,
  VOICEBRIDGE_DATA: DATA,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function runVb(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PC, 'bin', 'vb.js'), ...args], {
      cwd: PC,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  let bridgeOut = '';
  let bridgeErr = '';
  const bridge = spawn(process.execPath, [
    path.join(PC, 'bin', 'vb.js'), 'start', '--wrap',
    process.execPath, path.join(__dirname, 'mock-tui.js'),
  ], { cwd: PC, env });

  bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
  bridge.stderr.on('data', (d) => { bridgeErr += d.toString(); });

  try {
    await waitFor(() => bridgeOut.includes('MOCK-READY'), 15000, 'mock tui ready');
    check('supervisor starts child inside a real pty', bridgeOut.includes('MOCK-READY'));

    await waitFor(() => bridgeErr.includes('injector: pty'), 10000, 'injector mode');
    check('injector reports pty mode', bridgeErr.includes('injector: pty'));

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const send = (type, payload) => ws.send(JSON.stringify({
      v: 1, id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, ts: Date.now(), payload,
    }));

    send('hello', { deviceName: 'live-test-phone', appVersion: '0.0.1', protocolVersion: 1 });
    await waitFor(() => inbox.some((m) => m.type === 'hello_ok'), 5000, 'hello_ok');
    check('phone handshake completes', true);

    send('speech', { text: 'build the dashboard with dark mode' });
    await waitFor(() => bridgeOut.includes('SUBMIT:build the dashboard with dark mode'), 8000, 'injected prompt');
    check('spoken instruction is typed into the TUI input and submitted', true);

    const ack = inbox.find((m) => m.type === 'ack');
    check('phone receives an ack with the routing decision',
      Boolean(ack) && ack.payload.route === 'tui_inject',
      ack ? `route=${ack.payload.route}` : 'no ack');

    // ask_user round trip: a real `vb ask` process must block until the phone answers
    const askPromise = runVb(['ask', 'should I keep the old auth?', '--timeout', '25']);
    await waitFor(() => inbox.some((m) => m.type === 'listen'), 8000, 'listen frame');
    const listen = inbox.find((m) => m.type === 'listen');
    check('ask_user speaks the question to the phone', Boolean(listen) && listen.payload.question.includes('old auth'));

    await sleep(300);
    send('answer', { text: 'keep it, only improve the UI', forId: listen.payload.askId });
    const askResult = await askPromise;
    check('ask_user returns the spoken answer to the calling agent',
      askResult.code === 0 && askResult.stdout.includes('ANSWER: keep it, only improve the UI'),
      askResult.stdout.trim().split('\n').pop());

    // speak_to_user round trip
    const sayPromise = runVb(['say', 'dashboard is done']);
    await waitFor(() => inbox.some((m) => m.type === 'say' && m.payload.text === 'dashboard is done'), 8000, 'say frame');
    const sayResult = await sayPromise;
    check('speak_to_user reaches the phone', sayResult.code === 0 && sayResult.stdout.includes('spoken:'));

    // status round trip
    const statusResult = await runVb(['status', 'completed', 'all tests green']);
    check('voice_status updates and reaches the phone',
      statusResult.code === 0 && inbox.some((m) => m.type === 'status' && m.payload.state === 'completed'));

    // no-phone behaviour must not block
    ws.close();
    await sleep(400);
    const noPhone = await runVb(['ask', 'anyone home?', '--timeout', '2']);
    check('ask fails fast when the phone disconnects',
      noPhone.code === 4 && noPhone.stdout.includes('NO_ANSWER: phone_not_connected'),
      `exit=${noPhone.code}`);

    const offlineSay = await runVb(['say', 'nobody listening']);
    check('say reports not_spoken instead of lying',
      offlineSay.code === 4 && offlineSay.stdout.includes('not_spoken'),
      `exit=${offlineSay.code}`);
  } catch (err) {
    check(`live test aborted: ${err.message}`, false);
  } finally {
    bridge.kill();
    await sleep(300);
    if (!bridge.killed) bridge.kill('SIGKILL');
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (bridgeErr.trim()) {
    const noisy = bridgeErr.split('\n').filter((l) => l.includes('[vb]')).join('\n');
    if (noisy) process.stdout.write(`\nbridge log:\n${noisy}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
