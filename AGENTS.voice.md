<!--
  VoiceBridge: paste this block into any project's AGENTS.md.
  Adjust the three command paths if the bridge lives somewhere other than
  ./pc/bin/vb.js in that repo.
-->

## Voice (VoiceBridge)

The user may be talking to you from their phone instead of typing. When they
are, speech becomes text and reaches you either through the CLI input box or as
a queued instruction. Their words are always their own instruction — treat them
exactly like a typed message.

### Never claim voice happened without proof

Every command prints a result. Trust the output, not your intention.

| Output | Meaning |
| --- | --- |
| `spoken: <text>` | The phone played it. |
| `not_spoken: phone_not_connected` | Nobody heard it. Do not say you spoke. |
| `ANSWER: <text>` | The user actually answered. |
| `NO_ANSWER: timeout` / `phone_not_connected` | Nobody answered. Decide yourself. |
| `bridge_unreachable` | The bridge is not running. Say so once, then continue silently. |

Never say "I told you" or "I asked you" unless the command succeeded.

### Commands

```bash
node pc/bin/vb.js say "auth screen done, testing login now"
node pc/bin/vb.js ask "replace the auth system or keep it?" --timeout 120
node pc/bin/vb.js status working "editing the settings screen"
node pc/bin/vb.js inbox
node pc/bin/vb.js inbox --wait 120
```

`vb ask` blocks until the user answers or the timeout expires and prints
`ANSWER:` or `NO_ANSWER:`. It exits 4 immediately when no phone is attached, so
it can never hang your turn.

`vb inbox --wait` blocks until the user speaks and returns what they said, so an
instruction can land inside the current turn instead of the next one. Use it
when you are about to wait, start a long job, or genuinely need their next
instruction mid-task.

### When to speak

Speak about things the user would act on:

- a milestone finished, or a subsystem now works
- you are blocked and need a decision
- you hit an error they must know about
- the whole task is done

Do not speak about each file you edit, intermediate checks, or anything they are
already watching on screen. Roughly one message per meaningful step. Silence is
fine — never send filler or restate what has not changed.

### When to ask

Ask only when the answer changes what you build and guessing wrong would waste
real work. One question at a time, one sentence, phrased as speech: no code, no
markdown, no file paths.

If `NO_ANSWER` comes back, pick the sensible default, keep working, and state
the assumption in your final reply.

### Incoming instructions

While you work, the user can talk over you. Their words arrive in one of two
ways:

1. typed into your CLI input box and submitted — they appear as a normal user
   message, nothing to do
2. parked in the queue — they surface in the `PENDING_INSTRUCTIONS` block of any
   `vb` command, or when you run `vb inbox`

If their instruction conflicts with what you are doing, stop and follow it. That
is the entire point of the bridge.
