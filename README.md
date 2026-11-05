# VoiceBridge

**Talk to your coding agent from your phone.** The phone is the microphone, the
speaker and the status display. The PC keeps doing the coding.

```
 phone (Flutter, grayscale)                PC
┌────────────────────────┐                ┌─────────────────────────────────┐
│ speech_to_text         │  adb reverse   │ vb serve                        │
│   ── your voice ───────┼───────────────▶│  ├ token auth                   │
│                        │  tcp:8765      │  ├ queue.jsonl (persisted)      │
│ flutter_tts            │                │  ├ ask lifecycle + timeouts     │
│   ◀── agent speech ────┼────────────────│  └ injector ─▶ freebuff window  │
│ status · transcript    │                │       types + Enter             │
└────────────────────────┘                └─────────────────────────────────┘
                                                        ▲
                        node pc/bin/vb.js say "..."     │
                              (agent's shell tool) ─────┘
```

---

## Why it works this way

**The CLI input box is the message queue.** Freebuff exposes no hook for an
external process to inject a message into a running turn, and MCP has no channel
for it either. But the input box already queues what you type while the agent
works and applies it at a clean boundary. So voice is typed into that box,
exactly like keystrokes. Turn handling and ordering come from Freebuff itself
instead of a reimplementation.

**Two ways to get keystrokes in:**

| Mode | How | Needs |
| --- | --- | --- |
| `--wrap` | owns the process stdin through a PTY | agent launched by the bridge |
| `window` | raises the window, types, restores focus | agent already running |

`--wrap` is more reliable. `window` is what you use when the agent is already
open and you do not want to restart it.

**No MCP, no polling tool.** The agent-facing surface is a plain CLI documented
in `AGENTS.md`, because the agent already has a shell tool. Nothing to register,
nothing to approve, no extra tool traffic per turn.

---

## Verified

Measured on Windows 11, Node 24.18, Flutter 3.47.7, against an Infinix X6885
over USB.

| Check | Result |
| --- | --- |
| `cd pc && npm test` | **13/13 pass** |
| `node pc/test/live-e2e.js` | **11/11 pass** — real bridge, real WebSocket, real PTY |
| `node pc/test/live-probe-freebuff.js` | **5/5** — the real `freebuff` TUI renders under the PTY |
| `cd app && flutter analyze` | **No issues found** |
| `cd app && flutter test` | **1 pass** |
| `flutter build apk --debug` | **built** |
| Installed on device | **com.voicebridge.voicebridge** |
| Phone ↔ bridge over USB | **connected**, protocol v1 |
| Voice → agent input | **`route: tui_inject`**, verified in the queue log |
| Agent → phone speech | **confirmed audible** |

Not verified: a real multi-minute coding run with voice arriving mid-task, and
background execution (the app must stay in the foreground).

---

## Quick start

**1. PC dependencies**

```bash
cd pc && npm install
node pc/bin/vb.js doctor
```

**2. Build and install the app**

```bash
cd app
flutter build apk --debug --dart-define=VB_TOKEN=$(node ../pc/bin/vb.js token)
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

**3. USB tunnel** — `adb reverse`, not `forward`: the phone makes the outgoing
connection, so its `127.0.0.1:8765` must reach the PC.

```bash
./scripts/connect-phone.sh        # or .\scripts\connect-phone.ps1
```

**4. Start the bridge**

```bash
# already have freebuff open? point at its window instead:
node pc/bin/vb.js windows          # find the terminal title
node pc/bin/vb.js serve

# or launch the agent under the bridge (most reliable):
node pc/bin/vb.js start --wrap freebuff
```

For window mode, set the target in `pc/data/config.json`:

```json
"inject": { "mode": "window", "title": "Freebuff:", "stealFocus": true, "restoreFocus": true }
```

`stealFocus` raises the window, types, then hands focus back to whatever you were
using. It never types into a browser tab even when the title matches, because it
checks the process name.

**5. Speak.** Open the app and hold the circle. If you built without
`--dart-define`, paste the token from `node pc/bin/vb.js token` into settings.

---

## Add voice to any project

Copy [`AGENTS.voice.md`](AGENTS.voice.md) into that project's `AGENTS.md`, or
just append it:

```bash
cat AGENTS.voice.md >> /path/to/other/project/AGENTS.md
```

That block teaches the agent three things: never claim it spoke without a
successful command, when a message is worth saying out loud, and how to receive
your instructions while it works.

The agent then uses ordinary shell commands:

```bash
node pc/bin/vb.js say "authentication screen is done, testing login now"
node pc/bin/vb.js ask "replace the auth system or keep it?" --timeout 120
node pc/bin/vb.js status working "editing the settings screen"
```

`vb ask` blocks until you answer and prints `ANSWER: ...`. It exits 4 instantly
when no phone is attached, so it can never hang a turn.

---

## Commands

| Command | Purpose |
| --- | --- |
| `vb start --wrap <cmd…>` | run the bridge and own the agent's stdin |
| `vb serve` | bridge only, using the configured injector |
| `vb say "<text>" [--priority high]` | speak on the phone |
| `vb ask "<question>" [--timeout 120]` | speak a question, print `ANSWER:` or `NO_ANSWER:` |
| `vb status <state> [detail]` | thinking, working, waiting, speaking, completed, failed |
| `vb inbox` | print queued phone instructions |
| `vb inbox --wait 120` | block until the phone speaks, then print it |
| `vb windows` | list windows available for injection |
| `vb type "<text>"` | simulate a phone message |
| `vb state` | JSON snapshot |
| `vb doctor` | check node, pty, adb, port, bridge |
| `vb token` | print the connection token |

Exit codes: `0` ok, `1` bridge unreachable, `2` bad usage, `3` no answer
(timeout), `4` no phone attached / not spoken.

---

## Protocol

Newline-free JSON envelopes over one WebSocket at `/ws?token=…`.

```json
{ "v": 1, "id": "u_...", "type": "speech", "ts": 1793878250792,
  "payload": { "text": "add dark mode" } }
```

| Phone → PC | Purpose |
| --- | --- |
| `hello` | open session, send device info |
| `speech` | an instruction |
| `answer` | reply to an open `listen` |
| `interrupt` | stop speech or cancel a question |
| `ack` | confirm a PC message |
| `state` | mic and speaking state |

| PC → Phone | Purpose |
| --- | --- |
| `hello_ok` | session accepted, current status |
| `say` | speak this text |
| `listen` | speak this question, then listen |
| `status` | agent state |
| `transcript` | a line for the conversation view |
| `ack` | routing decision for your message |
| `error` | rejected message |

Every message carries an id. The queue is append-only JSONL, so a crash can only
lose the final line, and delivery marks records so nothing is applied twice.

Routing is one channel only:

1. an open question takes the words as its answer
2. a live injector types them into the agent
3. otherwise they park in the queue and surface on the next `vb` call

That ordering is enforced server-side, so a message can never be delivered twice.

---

## Configuration

`pc/data/config.json` (gitignored — it holds the token):

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `8765` | bridge port; match `adb reverse` |
| `host` | `127.0.0.1` | bind address |
| `token` | generated | required for HTTP and WebSocket |
| `inject.mode` | `off` | `off`, `window` |
| `inject.title` | `""` | window title substring to type into |
| `inject.stealFocus` | `false` | raise the window instead of refusing |
| `inject.restoreFocus` | `true` | give focus back afterwards |

Environment overrides: `VOICEBRIDGE_PORT`, `VOICEBRIDGE_HOST`,
`VOICEBRIDGE_TOKEN`, `VOICEBRIDGE_DATA`.

All HTTP routes require `X-VB-Token` (or `?token=` on the WebSocket), compared in
constant time. `/api/health` answers unauthenticated with no state, so nothing
can probe the token.

---

## How it is built

```
pc/lib/protocol.js   envelopes, ids, text sanitising (newlines would submit early)
pc/lib/store.js      append-only JSONL queue, survives a torn final line
pc/lib/hub.js        routing, ask lifecycle, status, transcript
pc/lib/server.js     HTTP API + WebSocket, auth, heartbeat, long-poll inbox
pc/lib/injector.js   PTY wrapper that types into a live TUI
pc/lib/win-inject.js Windows window injector (PowerShell + user32)
pc/bin/vb.js         CLI: start, serve, say, ask, status, inbox, doctor
app/lib/main.dart    the whole phone app: transport, TTS, STT, grayscale UI
AGENTS.voice.md      drop-in agent contract for any project
```

The app is one Dart file on purpose: reconnect with backoff, TTS, speech
recognition, transcript, and a black/white/gray UI with no other dependencies
beyond `web_socket_channel`, `flutter_tts`, `speech_to_text` and
`shared_preferences`.

---

## Troubleshooting

**The bridge says `spoken:` but the phone is silent.**

Some devices ship Google TTS with no engine selected, so `speak()` returns
success and plays nothing:

```bash
adb shell settings get secure tts_default_synth      # null means broken
adb shell settings put secure tts_default_synth com.google.android.tts
```

That was the real cause on the test device. The app now selects the Google
engine itself when installed, so a fresh install works without this step. Its
own log is the fastest check:

```bash
adb logcat -s flutter:* | grep VOICEBRIDGE_TTS
```

**`not sent — the Freebuff window is not focused`.**

Window mode refuses rather than typing into the wrong place. Turn on
`inject.stealFocus`, or use `--wrap`, which needs no focus at all.

**`EADDRINUSE` on startup.**

An older bridge still owns the port; the CLI was talking to stale code:

```bash
netstat -ano | grep :8765
taskkill //F //PID <pid>
```

**Voice is queued but the agent never sees it.**

Nothing is typing into it. Check `vb state` for `"injector": "attached"`.

---

## Limitations

- **`window` mode is Windows only** and depends on the window title. `--wrap`
  works anywhere.
- **No background service** — the app must stay in the foreground.
- **No wake word** — you press to talk.
- **One phone at a time**; a second connection replaces the first.
- **Speech during an open question counts as the answer**, even if it was meant
  as a new instruction. The agent is told to stop and follow it either way.

---

## Layout

```
pc/       bridge, CLI, protocol, tests
app/      Flutter phone app (Android)
scripts/  USB tunnel setup (bash + PowerShell)
```
