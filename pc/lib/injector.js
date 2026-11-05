'use strict';

const { spawn } = require('child_process');
const { sanitizeText } = require('./protocol');

const ENTER_DELAY_MS = 80;

function loadPty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A wrapper process that owns a child's stdin so we can type into it.
 * Two transports:
 *   pty  - real terminal, the TUI enables raw mode and behaves normally
 *   pipe - fallback, child stdin is a pipe (works for line readers)
 */
class Injector {
  constructor({ command, args = [], cwd, env, cols = 120, rows = 40 }, handlers = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = env || process.env;
    this.cols = cols;
    this.rows = rows;
    this.handlers = handlers;
    this.mode = 'none';
    this.ready = false;
    this.queue = Promise.resolve();
    this.child = null;
  }

  start() {
    const pty = loadPty();
    if (pty) {
      const proc = pty.spawn(this.command, this.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: this.env,
      });
      this.child = proc;
      this.mode = 'pty';
      proc.onData((data) => this.handlers.onData && this.handlers.onData(data));
      proc.onExit((ev) => {
        this.ready = false;
        if (this.handlers.onExit) this.handlers.onExit(ev);
      });
      this.ready = true;
      return this;
    }

    const proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    this.child = proc;
    this.mode = 'pipe';
    proc.on('exit', (code, signal) => {
      this.ready = false;
      if (this.handlers.onExit) this.handlers.onExit({ code, signal });
    });
    this.ready = true;
    return this;
  }

  writeRaw(data) {
    if (!this.ready || !this.child) return false;
    if (this.mode === 'pty') this.child.write(data);
    else this.child.stdin.write(data);
    return true;
  }

  /**
   * Type text then press Enter. Serialized so two utterances can never
   * interleave into one malformed prompt.
   */
  submit(text) {
    const clean = sanitizeText(text);
    if (!clean) return { ok: false, reason: 'empty' };
    if (!this.ready) return { ok: false, reason: 'not_running' };

    const run = async () => {
      this.writeRaw(clean);
      await delay(ENTER_DELAY_MS);
      this.writeRaw('\r');
    };
    this.queue = this.queue.then(run, run);
    return { ok: true, mode: this.mode, text: clean };
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.mode === 'pty' && this.child && this.child.resize) {
      try {
        this.child.resize(cols, rows);
      } catch {
        // child already gone
      }
    }
  }

  stop() {
    this.ready = false;
    if (!this.child) return;
    try {
      if (this.mode === 'pty') this.child.kill();
      else this.child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
}

module.exports = { Injector, loadPty };
