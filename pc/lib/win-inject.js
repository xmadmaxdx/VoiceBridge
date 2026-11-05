'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeText } = require('./protocol');

const PS1 = path.join(__dirname, 'win-inject.ps1');

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('window injection is Windows only; use --wrap on other platforms');
  }
}

function run(args) {
  const res = spawnSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', PS1,
    ...args,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

function listWindows() {
  assertWindows();
  const out = run(['-Mode', 'list']).stdout;
  return out
    .split(/\r?\n/)
    .map((line) => {
      const [handle, pid, ...rest] = line.split('\t');
      return { handle: Number(handle), pid: Number(pid), title: rest.join('\t') };
    })
    .filter((w) => w.title && Number.isFinite(w.handle));
}

/**
 * Types into a window that is ALREADY focused. If the user has switched to
 * another app, this refuses instead of stealing focus, so text can never be
 * delivered to the wrong window.
 */
class WindowInjector {
  constructor({ title, stealFocus = false, restoreFocus = true }) {
    if (!title) throw new Error('WindowInjector needs a window title to match');
    this.title = title;
    this.stealFocus = stealFocus;
    this.restoreFocus = restoreFocus;
    this.mode = stealFocus ? 'window+focus' : 'window';
    this.ready = true;
  }

  submit(text) {
    const clean = sanitizeText(text);
    if (!clean) return { ok: false, reason: 'empty' };

    const tmp = path.join(os.tmpdir(), `vb-type-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, clean, 'utf8');
      const args = ['-Mode', 'type', '-Title', this.title, '-TextFile', tmp];
      if (this.stealFocus) args.push('-StealFocus');
      if (this.restoreFocus) args.push('-RestoreFocus');
      const res = run(args);
      const out = res.stdout;
      if (out.startsWith('ERROR:')) {
        const detail = out.slice('ERROR:'.length).trim();
        const reason = detail.startsWith('not_focused')
          ? 'window_not_focused'
          : detail.startsWith('focus_failed')
            ? 'focus_failed'
            : detail.startsWith('no_visible_window_matching')
              ? 'window_not_found'
              : detail.startsWith('refused_browser_window')
                ? 'refused_browser_window'
                : 'window_inject_failed';
        return { ok: false, reason, detail };
      }
      if (res.status !== 0) {
        return { ok: false, reason: 'window_inject_failed', detail: res.stderr.slice(0, 200) };
      }
      return { ok: true, mode: 'window', detail: out };
    } catch (err) {
      const message = String(err.message || '').split('\n')[0].slice(0, 200);
      return { ok: false, reason: 'window_inject_failed', detail: message };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // temp file already gone
      }
    }
  }

  stop() {
    this.ready = false;
  }
}

module.exports = { listWindows, WindowInjector };
