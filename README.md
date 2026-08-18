# opus voice

Hands-free spoken conversation with Claude, in the terminal. You talk, it thinks,
it answers out loud, and you can cut it off mid-sentence the way you would a person.

```
opus voice · opus · piper neural · on-device en-IN
  ›  asleep — say "falcon" to wake

you  falcon, why is my build slow?
     … "mm, let me think"
opus It's the cache — it's rebuilding from scratch every run.
     That's most of your build time, and it's a two-line fix.
     Want me to walk you through it?
```

## Wake word

It sleeps by default and ignores everything until it hears its name, so you can
leave it running while you work or take a call.

| say | what happens |
|---|---|
| **"falcon"** | wakes up and waits for you |
| **"falcon, why is X slow?"** | wakes and answers in one go |
| **"falcon listen"** | note mode: captures the discussion silently, never replies |
| **"falcon let's discuss"** | chat mode: stays awake until you stop it |
| **"falcon stop"** | back to sleep (ends note mode and writes the summary) |

Once it is already listening, the name is optional for commands — "go to sleep"
or just "stop" works on its own. That only applies to short utterances that are
nothing but the command, so "how do I stop the dev server" stays a question.
While asleep, and while taking notes, the name is always required.

Awake and chat both fall asleep after 30 seconds of silence, and need "falcon"
again to come back. The countdown starts when it finishes answering, not when
you finish asking, so a long answer never cuts itself off. Note mode is exempt —
it sits through a whole discussion and waits for "falcon stop". Typing never
needs a wake word.

The name is matched by edit distance plus a list of common mishearings, because
recognition returns "Jervis", "Java's" and "service" fairly often. Ambiguous ones
only count as the first word, so talking about *the service* won't wake it.

Set `"wakeWord": false` to go back to answering everything it hears.

### Note mode

`falcon listen` captures the conversation without speaking. On `falcon stop` it
writes `notes/YYYY-MM-DD-HHMM.md` in the working directory — a summary of what was
discussed, decisions, and action items, followed by the full transcript — then
reads a two-sentence version aloud.

## Setup

One command. It installs everything, checks it actually works, and tells you the
only two things it cannot do for you.

```sh
curl -fsSL https://raw.githubusercontent.com/Bala-vignesh-kumar/opus-voice/main/install.sh | bash
```

Or in a clone:

```sh
./install.sh
```

It checks macOS and the Swift toolchain, installs Node if Homebrew is around,
builds both binaries, downloads the neural voice and synthesizes a test phrase to
prove it, creates your `config.json`, installs the `claude` CLI, and finishes with
a ✓/✗ for every part. Re-running it is safe — it skips what is already done and
never overwrites your settings.

Two things need you:

- **Sign in to Claude.** Run `claude` once and sign in with your existing
  subscription. There is no API key anywhere in this project.
- **Turn on Dictation** — System Settings › Keyboard › Dictation. Apple's
  recognizer will not start at all without it. Let the language download finish,
  or names come back mangled.

Then:

```sh
npm run app         # desktop window
npm start           # terminal
```

The first run asks for **Microphone** and **Speech Recognition** permission. macOS
attributes those to your terminal app, so the prompt says Terminal or iTerm rather
than opus voice. If you miss the prompt, grant them under System Settings ›
Privacy & Security.

Requires macOS, Node 18+, the Swift toolchain (Xcode command line tools), and a
working `claude` CLI. No API key — it uses the Claude Code auth you already have.

Install it somewhere with a short path, like `~/opus-voice`. The speech engine
keeps its data path in a fixed 160-character buffer, and an install buried deep
enough to overflow it falls back to the robotic system voice. `install.sh` warns
you if you are close.

## The window

`npm run app` opens a real Mac window instead of the terminal: the conversation as
it happens, what it is hearing right now, the mode, tool calls as they run, and
buttons for the same things you say out loud — discuss, take notes, sleep — plus a
box to type in. Escape cuts it off mid-sentence, the way talking over it does.

It is a WKWebView, not Electron: a few hundred kilobytes of AppKit that already
ships with the machine, so installing it does not mean downloading a second
browser. The window renders and nothing else — every decision still happens in
`src/`, and the terminal UI keeps working exactly as before. Audio never goes near
it, because echo cancellation only works while capture and playback share one
engine.

The server binds to loopback and requires a token generated at startup, which is
in the URL printed when it opens. That token is the only thing stopping any page
you happen to have open from posting commands to a process that can edit files and
run shell commands.

### The voice

Default is **Piper**, a neural text-to-speech engine that runs locally. No API key,
no per-word cost, no audio leaving the machine. Install it once:

```sh
npm run install-piper
```

That fetches the engine and a voice model into `vendor/` (~90MB). It synthesizes
about 10x faster than realtime and streams, so audio starts ~300ms after the text.

Other voices — pass any name from
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices):

```sh
./scripts/install-piper.sh en_US-ryan-high
```

Then set `"piperVoice": "en_US-ryan-high"` in `config.json`.

**Falling back to Apple.** Set `"tts": "apple"` to use system synthesis instead;
it also happens automatically if Piper isn't installed. Apple's compact voices are
the robotic ones, so if you go that route, download an **Enhanced** or **Premium**
voice from System Settings › Accessibility › Spoken Content › Manage Voices
(Ava Premium is the good one) and set `"voice": "Ava"`. `npm run voices` shows what
you have.

## Troubleshooting

**It starts, the mic indicator is on, but nothing you say registers.**

Almost always Dictation. Apple's speech recognizer refuses to run at all — even the
server-based path — when Dictation is off, and it reports
`kLSRErrorDomain 201: Siri and Dictation are disabled`.

Turn on **System Settings › Keyboard › Dictation**, wait for the language download
to finish, then restart. Enabling Siri also works.

To confirm where the problem is:

```sh
npm run mic-test
```

It shows a live level bar and any transcripts for 20 seconds, then tells you which
half is broken — a moving bar with no transcript means audio is fine and
recognition isn't, a flat bar means the input device is wrong.

**It hears me but cuts me off mid-sentence.** Raise `endpointMs` (try 1100). If it
cuts you off only when you pause after a complete sentence, raise `endpointFastMs`.

**It interrupts itself.** Raise `bargeInWords` to 3. Headphones eliminate this
entirely, since there's no acoustic path from speaker back to mic.

## How it works

Two processes, or three with the window open.

**`bin/voiceio`** (Swift) owns all the audio: microphone capture, Apple's on-device
speech recognizer, and speech synthesis. These live in one process on purpose. The
voice-processing audio unit only cancels echo from audio rendered through its own
output, so synthesized speech is played back through the same engine that is
capturing the mic. Hand playback to `say` instead and the mic hears the Mac talking,
which makes it interrupt itself in a loop. It speaks newline-delimited JSON.

When Piper is the engine, Node synthesizes the audio and streams raw PCM into the
same Swift engine rather than playing it separately — otherwise echo cancellation
loses its reference signal and barge-in starts firing on our own voice.

**`src/`** (Node) owns the conversation: it keeps one long-lived `claude` process in
streaming-JSON mode for the whole session, so process startup is paid once at launch
rather than on every question, and history is retained by the session itself.

**`bin/voiceapp`** (Swift, optional) is the window. It draws what `src/bus.mjs` holds
and posts back what you click. Both surfaces go through `src/view.mjs`, so the
terminal and the window can never disagree about what was said.

```
mic ──> on-device recognition ──> endpoint detection ──> "final"
                                                            │
                                                            ▼
                                                    claude (persistent)
                                                            │
                                       thinking (never spoken) │ text
                                                            ▼
speaker <── synthesis <── sentence chunker <── markdown stripped
```

### Think, then speak

Opus reasons in thinking blocks that arrive as a separate content type and are
never routed to the synthesizer — what you hear is the conclusion, not the working
out. Because that reasoning takes a couple of seconds, a short filler ("mm, let me
think") plays after 250ms so the gap isn't dead air. If an answer comes back faster
than that, the filler never fires.

The system prompt in `src/style.mjs` is what stops it reading markdown aloud: answer
in the first sentence, prose instead of bullet points, offer long content rather
than dumping it, hand the turn back.

### Interrupting

Your speech is transcribed even while it's talking. Two recognised words stop
playback immediately and start a new turn; the rest of the generated answer is
discarded. The word threshold plus echo cancellation plus a self-echo filter are
three independent guards against it interrupting itself.

## Configuration

`config.json`, or `--flag value` on the command line for any of the same keys:

| key | default | what it does |
|---|---|---|
| `model` | `opus` | any alias the `claude` CLI accepts |
| `effort` | `medium` | `low` is noticeably snappier, `high` thinks longer |
| `tts` | `piper` | `piper` (local neural) or `apple` (system voice) |
| `piperVoice` | `en_US-hfc_female-medium` | Piper model name |
| `voice` | *best installed* | Apple voice name, used when `tts` is `apple` |
| `rate` | `0.52` | speaking rate, 0 to 1 |
| `endpointMs` | `700` | silence that ends your turn mid-sentence |
| `endpointFastMs` | `400` | silence needed when you clearly finished a sentence |
| `dir` | *where you launched it* | project it can read and edit |
| `permissionMode` | `bypassPermissions` | `acceptEdits` allows file edits but not shell |
| `narrateTools` | `true` | speak "let me look at that" when a tool runs |
| `bargeInWords` | `2` | words needed to interrupt |
| `fillerDelayMs` | `250` | grace period before the thinking beat |
| `wakeWord` | `true` | require "falcon" before it answers |
| `awakeTimeoutMs` | `30000` | silence in awake or chat before it sleeps again |
| `locale` | `en-IN` | accent the recognizer listens for |
| `ui` | `false` | open the desktop window (`npm run app` sets it) |
| `uiPort` | `4477` | loopback port for the window, steps up if taken |
| `greeting` | *see config* | spoken at startup, `""` to disable |

```sh
npm start -- --voice Zoe --effort low --endpoint-ms 600
```

## Speed

Measured on this machine, from end of speech to first spoken word:

| stage | cost |
|---|---|
| endpoint detection | 400ms after a finished sentence, 700ms mid-thought |
| Claude Code CLI first token | 1000-1950ms |
| sentence chunking | ~50ms (first sentence takes a fast path) |

**The CLI is the floor.** Model and effort barely move it — opus/low measured
2246ms, opus/medium 2087ms, sonnet/low 1912ms on a cold turn. Shortening the system
prompt and `--exclude-dynamic-system-prompt-sections` made no meaningful difference
either. Roughly 1 second of it is unavoidable per-turn overhead.

Getting below that needs the Anthropic API directly instead of the CLI, which means
an API key. That would put first token at roughly 600ms.

The thinking filler fires at 250ms, so you hear *something* almost immediately even
though the real answer lands around two seconds.

To see the numbers yourself:

```sh
OPUS_VOICE_TIMING=1 npm start
```

## Tools

Full access: it can read, search, edit files and run commands in the working
directory shown in the banner. Permission prompts are bypassed, because anything
that stops to ask becomes an unexplained silence you can't answer by voice.

Tool calls are narrated out loud so a pause sounds like working rather than
crashed. Run it in a git repo with a clean tree — speech recognition mis-hears, and
a misheard instruction can now change files.

To allow file edits but not arbitrary shell commands, set
`"permissionMode": "acceptEdits"`.

## Tests

```sh
npm test
```

Covers the sentence chunker (streaming boundaries, abbreviations and decimals,
markdown stripping, never speaking the inside of a code block), wake phrase
matching (mishearings, mode commands, false-wake resistance), the conversation
state the window renders from, how the thinking beat is chosen, and the window
server — including that a command without the right token is refused.
