# AGENTS.md — VoiceBridge

This repo is a voice bridge. When the user is talking to you from their phone,
these rules apply. If they are sitting at the keyboard, ignore the whole file.

## Do not lie about voice

Every command prints a result. Trust it, not your intention.

| Output | What it means |
| --- | --- |
| `spoken: <text>` | The phone played it. |
| `not_spoken: phone_not_connected` | Nobody heard it. Do not claim you spoke. |
| `ANSWER: <text>` | The user actually answered. |
| `NO_ANSWER: timeout` / `phone_not_connected` | Nobody answered. Decide yourself. |
| `bridge_unreachable` | The bridge is not running. Say so once, then continue silently. |

Never say "I told you" or "I asked you" unless the command above succeeded.

## Commands

Run these from the repo root, through your normal shell tool.

```bash
node pc/bin/vb.js say "authentication screen is done, testing login now"
node pc/bin/vb.js ask "replace the auth system or keep it?" --timeout 120
node pc/bin/vb.js status working "editing the settings screen"
node pc/bin/vb.js inbox
node pc/bin/vb.js inbox --wait 120
node pc/bin/vb.js state
```

On PowerShell, `.\vb.ps1 say "..."` is equivalent. In bash, `./vb say "..."`.

`vb ask` blocks until the user answers or the timeout expires, and prints
`ANSWER:` or `NO_ANSWER:`. It exits 4 immediately when no phone is attached, so
it can never hang your turn.

## When to speak

Speak about things the user would act on:

- a milestone finished, or a subsystem now works
- you are blocked and need a decision
- you hit an error the user must know about
- the whole task is done

Do not speak about:

- each file you edit
- passing intermediate checks
- anything the user is watching on screen

Roughly one message per meaningful step. Silence is fine. Do not send filler,
and never send a message that says nothing new.

## When to ask

Ask only when the answer changes what you build, and when guessing wrong would
waste real work. One question at a time, one sentence each, phrased the way a
person would say it out loud — no code, no markdown, no file paths.

If `NO_ANSWER` comes back, pick the sensible default, keep working, and state
the assumption in your final reply.

## Incoming instructions

While you work, the user can talk over you. There are two ways their words
reach you:

1. **Typed into the CLI** — with `vb start --wrap freebuff`, their speech is
   typed into your own input box and submitted, so it arrives as a normal user
   message. Nothing to do.
2. **Parked in the queue** — with `vb serve` only, their words wait until you
   run any `vb` command that prints a `PENDING_INSTRUCTIONS` block, or until
   you run `vb inbox`.

If the user is on the phone and you are about to wait, start a long job, or you
want their next instruction mid-task, block on `vb inbox --wait 120`. It returns
the instant they speak, prints what they said, and exits 3 if nothing arrives.

If their instruction conflicts with what you are doing, stop and follow the
new instruction. That is the point of the bridge.
