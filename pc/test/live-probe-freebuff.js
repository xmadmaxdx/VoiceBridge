'use strict';

/**
 * Proves the real freebuff binary starts and renders its TUI inside our pty
 * wrapper. Nothing is typed and no prompt is submitted, so no session or
 * freebucks are consumed.
 */

const { Injector } = require('../lib/injector');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripAnsi(input) {
  return input
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '');
}

async function main() {
  const isWin = process.platform === 'win32';
  const command = isWin ? process.env.ComSpec || 'cmd.exe' : 'sh';
  const args = isWin ? ['/c', 'freebuff'] : ['-lc', 'freebuff'];

  let raw = '';
  let exited = null;
  const injector = new Injector({ command, args, cwd: process.cwd(), cols: 120, rows: 36 }, {
    onData: (d) => { raw += d; },
    onExit: (ev) => { exited = ev; },
  });

  injector.start();
  process.stdout.write(`started freebuff under ${injector.mode} (${command} ${args.join(' ')})\n`);

  await sleep(12000);
  injector.stop();
  await sleep(500);

  const clean = stripAnsi(raw);
  const lines = clean.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length);
  const lower = clean.toLowerCase();

  const checks = [
    ['tui produced output', raw.length > 200, `${raw.length} bytes`],
    ['output contains cursor control (a real TUI drew)', raw.includes('\u001b['), 'ansi present'],
    ['prompt input area rendered', lower.includes('coding task') || lower.includes('/ for commands'), ''],
    ['status line rendered', lower.includes('/model to change'), ''],
    ['no crash or usage error', !lower.includes('usage:') && !lower.includes('is not recognized'), ''],
  ];

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
  }

  const compact = lines
    .map((l) => l.replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 3 && l.length < 160);
  process.stdout.write(`\n--- last meaningful rendered lines ---\n${compact.slice(-6).join('\n')}\n`);
  if (exited) process.stdout.write(`\nchild exited: ${JSON.stringify(exited)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
