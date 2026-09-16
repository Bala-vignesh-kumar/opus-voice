# Decisions, and what they cost to learn

Every entry here is a decision that looks arbitrary in the code, plus the
measurement that settled it. The point is that nobody has to pay for these
twice. Where a decision could reasonably be revisited, that is said.

Measurements were taken on the owner's machine: Apple silicon, macOS Darwin
25.6, AirPods Pro 2 (`0x2024`, firmware 8B41). Numbers involving speed are
machine- and load-specific. Numbers involving *behaviour* — what Bluetooth does,
what CoreAudio does — are not.

---

## Audio and hardware

### The AirPods microphone is a telephone

**Measured:** 3.6% of signal energy above 6 kHz, against roughly 8% for the
built-in microphone on the same speech.

A Bluetooth headset microphone runs over HFP, which is narrowband. The moment
anything opens it, the whole link drops out of A2DP into SCO and the audio
quality of *both* directions collapses.

**So:** `micDevice` defaults to `builtin`, and voiceio switches the *system
default input* away from a Bluetooth headset at startup, restoring it on exit.

### Switching the input device has to happen at the system level

Switching the input on the `AVAudioInputNode` fails with `-10875` unless the
voice-processing IO unit is enabled — and that unit is exactly what we do not
want (see below). All four combinations were tried. Setting the system default
input device is the one that works.

### `micDevice` must be a launch argument, not a config key

The input device is chosen during `setupAudio()`. The `configure` command does
not arrive from node until after `ready`. A preference read from `configure` is
therefore always one step too late — it was silently ignored for the entire
life of the setting. It is `--mic-device` on the command line now, for the same
reason `--echo-cancellation` is.

### Voice processing destroys recognition accuracy

`setVoiceProcessingEnabled(true)` gives AEC, AGC and noise suppression tuned for
telephony. It measurably degrades what the recognizer hears. This was found by
comparing against macOS Dictation, which does not use it.

**So:** off by default. `"echoCancellation": true` turns it back on, and is only
worth it when the answer plays through speakers the microphone can hear.

### Through laptop speakers it answers itself, and needs guarding twice

The condition the line above describes actually happened, on 4 Sep 2026: output
on the MacBook speakers, input on the built-in microphone, echo cancellation
off. Every noise the app made came back down its own microphone about two
seconds later and was taken for a question.

**Measured**, from `~/.falcon/falcon.log` — `···` is the live partial:

```
··· Sure  ··· Sure, let's  ··· Sure, let's talk.   <- its own Discuss reply
you  How is falcon?                               <- a real turn
··· H  ··· Hang  ··· Hang on.                     <- its own thinking beat
you  Hang on.                                     <- asked back as a question
```

Nothing already in the app could have caught it. The peak floor in
`transcript-guard.mjs` is 0.02 and its own voice arrived between 0.029 and
0.393; the stock-phrase list there is aimed at what Whisper invents out of
silence and holds one of the app's own phrases only by coincidence. Worse,
`bargeInWords` is 2 and "hang on" is two words, so its own beat also counted as
the user interrupting: it cut itself off to listen to itself.

**So:** two guards, because each covers what the other cannot.

1. `"echoCancellation": true` — what this setting is for, and `EchoPolicy`
   already permits it when output is not a headset. It costs recognition
   accuracy, and note that the decision is made once in `setupAudio()`:
   `watchRoute()` restarts the keepalive but never re-runs `echoDecision`, so
   moving output to AirPods **after** launch leaves the duplex path open and
   the squeeze dead.
2. `src/echo-guard.mjs` — the app knows exactly what it just said, and refuses
   a transcript that is a run of words out of it within `echoWindowMs`. Fed
   from `speaker.emit('said')` rather than from the seventeen callers of
   `speaker.say`. It also stops the app taking its own "going to sleep." for an
   instruction, and stops its own voice counting as barge-in.

Guard 2 is the one that still works on bluetooth output, where guard 1 is
refused outright.

#### Echo cancellation on, and it still heard itself — 16 Sep 2026

Same route as above — MacBook Pro Speakers out, built-in microphone in — but
this time `"echoCancellation": true`, and `EchoPolicy` enabled it (no warning
in the log; the output is not bluetooth). The answer still came back:

```
falcon  Sure — I'm talking. Want me to keep going so you can hear the new voice…
···  Sure, I        (interrupted)
···  Sure, I'm talking.   ···  Want me to keep going so
        audio dumped to /tmp/dump-4.wav (7.2s, peak 0.243)
you  So I'm talking on my bookie drawings like any other new files, files,
```

**Measured** on the dump: 7.2 s, 16 kHz, no clipping, energy a steady −27 to
−36 dB across the whole buffer, peak 0.243. Whisper `base` heard "bookie
drawings"; Whisper `small` heard "Sure, I am talking on my to keep going so
you can hear the new voice" — the app's own sentence. So the voice-processing
unit did **not** cancel Piper's playback to anything like silence: the residual
was loud enough for two recognizers to transcribe it.

Two guards should have caught it and did not, and both are fixed:

1. Barge-in fired on the partial `Sure, I` — two words, so it counted — and
   `isEcho` compared `i` against `i'm` and said no. Partials stop mid-word.
   `isEcho(text, { partial: true })` now lets the last word be a prefix.
2. The final was checked only after Whisper had replaced it. Apple's text was
   the app's sentence verbatim; Whisper's was garbage that matched nothing.
   The system recognizer's text is now checked first.

**Not fixed, and worth knowing:** why VPIO leaks this much with the player on
the same engine is still open. The software guards are the real defence, as the
4 Sep section already says; the setting is a reduction, not a seal.

### An AirPods squeeze needs an audio stream to exist

**The most expensive finding in the project.** AirPods only emit an AVRCP
play/pause when there is an active stream to control. With none, the press dies
at the bud — no command is sent, so no application can receive one.

**Measured**, from `/usr/bin/log show`, field `AStS` (audio stream state):

| condition | stream state | squeeze delivered |
|---|---|---|
| nothing playing | `Idle` (hundreds of samples) | never |
| silent stream held open | `A2DP` | every time |
| app holding the AirPods mic | `SCO` | never |

Two independently registered listeners — a standalone probe and the app —
received nothing while `Idle`. It appeared to work earlier only because Spotify
happened to be playing.

**So:** `swift/Keepalive.swift` holds a silent stream open forever.

### The keepalive must not use `AVAudioEngine`

`AVAudioEngine` opens a **duplex** IO unit — it takes the microphone as well as
the speaker. That puts the AirPods into SCO, where a single press means "end
call", not play/pause. An engine-based keepalive therefore defeats the exact
thing it exists to enable, and is audible while doing it.

**So:** `AVAudioPlayer` looping a silent WAV generated in memory. Output only.

### The squeeze and the AirPods microphone cannot both work

Making the AirPods the system input pins the link into SCO **even after the app
releases the microphone** — the app logs "microphone released" and the link
stays SCO. Single press then means end-call.

This is a genuine either/or:

| input device | link | squeeze | recognition |
|---|---|---|---|
| `builtin` | A2DP | works | far-field, Whisper struggles |
| `default` | SCO | impossible | close-mic, much better |

**Currently:** `builtin`, chosen by the owner in favour of the squeeze. If that
is ever reversed, switch `stt` to `apple` at the same time — see below.

### Do not re-add a Now Playing re-claim timer

Claiming the role on a 20-second timer broke the gesture that a single claim at
startup had working. There is no API to ask who holds the role — Apple locked
down MediaRemote — so this cannot be verified directly, only by whether the
gesture works. It was reverted to a single claim. Leave it alone.

---

## Recognition

### Two recognizers, and why

Apple's `SpeechTranscriber` runs live and drives partials, barge-in and
endpointing, which it is good at. Whisper re-transcribes the finished
utterance's audio, which it is better at — *given a correct buffer*.

### The buffer is the whole problem

Whisper was nearly abandoned on evidence that turned out to be entirely about
broken buffers: 13-second and 30-second captures spanning whole conversations,
including the app's own speech, or trims that cut the speech out and left
silence. On the same audio, correctly bounded:

```
Apple:    "Checkakhatra residency in the"
Whisper:  "Check Nakshathra Residency in the code base."   ← what was said
```

**Check the buffer first.** Length, and where the energy is. A 30-second buffer
holding one second of speech is a bug in the turn logic, not a bad model.

### Model choice is not settled

On four real recordings from this machine, warmed up:

| | dump-11 (7.0s) | dump-12 (10.9s) | dump-10 (30s) |
|---|---|---|---|
| `base` | 1.06s — correct | 0.27s — correct | 3.09s |
| `small` | 2.34s — wrong | 0.82s — wrong | 1.55s |

`base` was faster *and* more accurate here. But `small` is what got
"Nakshathra Residency" right on close-mic audio. The honest reading: `base` is
better on far-field, `small` on close-mic. Currently `base`, matching the
built-in microphone.

Under load `small` took 7–12.6s against an 8s timeout, and every timeout means
falling back to Apple's transcript silently. If you raise the model, raise
`whisperTimeoutMs` with it and check the log for `whisper timed out`.

### Whisper hallucinates on noise, not on the glossary

Suspecting the vocabulary prompt of poisoning output is natural and was tested:
identical garbage with and without it. Degenerate repetition ("I don't know. I
don't know.") and stock phrases mean the audio has no intelligible speech in it.
`src/transcript-guard.mjs` catches the common shapes.

### Endpoint timing is a real trade

`endpointMs` is silence that ends a turn mid-sentence; `endpointFastMs` is
silence needed when a sentence clearly finished. Setting **both** to 3000 —
which was done on request — means a finished sentence waits three seconds, and
with any room noise the turn may never close at all, so the next thing said
lands inside the previous turn's buffer. That is what "it doesn't hear my second
sentence" was.

**Currently:** `endpointMs` 3000 as asked, `endpointFastMs` 800.

### A VAD trim of the utterance buffer made things worse

Tested against four real recordings: two better, one unchanged, one turned a
correct "Hey, how are you?" into `""`. Removed from the turn path. The buffer is
capped at 30 seconds as a ceiling, not trimmed as a policy.

---

## Process and lifecycle

### GUI processes get a minimal PATH

Launched from the Finder or at login, the app inherits
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew is not on it. The `claude` CLI
was spawned by bare name and failed with `ENOENT` — no answers at all, while
everything looked healthy. Resolved explicitly now, the way node already was.

**Anything spawned by name will hit this.** Resolve it.

### A failed spawn never emits `exit`

Node emits `error` and `close`, not `exit`. Code that clears state on `exit`
does not run, so a turn that set `busy` held it for the life of the process and
every later question was dropped in silence. Spawn failures are reported as
exits so the restart policy sees them.

### The window's token dies with the node process

The URL carries the session token; node mints a new one each start. `EventSource`
treats any non-200 as **fatal and never retries** — so one restart leaves the
window frozen on its last frame with an empty library, looking broken while the
backend is perfectly healthy. `OpusVoiceApp` now reloads the web view whenever
the session changes.

### Restart, do not exit

Both the Claude session and the audio daemon are replaced when they die, with a
three-in-a-minute give-up. Before this, unplugging headphones ended the app.

---

## Still open

- **Semantic endpointing.** Deciding a turn has ended from meaning rather than
  silence. Never specified.
- **Speech-to-speech models.** Discussed, not built. Would conflict with the
  local-only rule unless run locally.
- **The Siri shortcut is still named "Run Shell Script".** So `"Hey Siri,
  falcon"` addresses nothing. The path works — `shortcuts run "Run Shell Script"`
  wakes it. Renaming it is a manual step in the Shortcuts app; the CLI cannot
  rename. Until then the log warns on every launch, correctly.
