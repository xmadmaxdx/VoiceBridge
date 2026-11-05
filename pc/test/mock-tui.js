'use strict';

// Stand-in for an interactive TUI: reads raw keystrokes, echoes submitted
// lines. Used to prove that injected text plus Enter arrives as a prompt.
process.stdout.write('MOCK-READY\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.resume();

process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      if (buffer) process.stdout.write(`SUBMIT:${buffer}\n`);
      buffer = '';
    } else if (ch === '\u007f' || ch === '\b') {
      buffer = buffer.slice(0, -1);
    } else if (ch >= ' ') {
      buffer += ch;
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
