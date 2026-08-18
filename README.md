# opus voice

Hands-free spoken conversation with Claude, in the terminal. You talk, it thinks,
it answers out loud, and you can cut it off mid-sentence the way you would a person.

```
opus voice · opus · piper neural · on-device en-IN
  ›  asleep — say "hey falcon" to wake

you  hey falcon, why is my build slow?
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
| **"hey falcon"** | wakes up and waits for you |
| **"hey falcon, why is X slow?"** | wakes and answers in one go |
| **"hey falcon listen"** | note mode: captures the discussion silently, never replies |
| **"hey falcon let's discuss"** | chat mode: stays awake until you stop it |
| **"hey falcon stop"** | back to sleep (ends note mode and writes the summary) |

Once it is already listening, the name is optional for commands — "go to sleep"
or just "stop" works on its own. That only applies to short utterances that are
nothing but the command, so "how do I stop the dev server" stays a question.
While asleep, and while taking notes, the name is always required.

Awake and chat both fall asleep after 30 seconds of silence, and need the phrase
again to come back. The countdown starts when it finishes answering, not when
you finish asking, so a long answer never cuts itself off. Note mode is exempt —
it sits through a whole discussion and waits for "hey falcon stop". Typing never
needs a wake word.

It is two words for the same reason Siri and Alexa are. A lone name has to be
picked out of a stream of unrelated speech, and at that job one short word is
hopeless — it competes with every similar-sounding word in the language. A
greeting in front roughly doubles the acoustic evidence, and the pair almost
never occurs by accident, so the matcher can be generous about how each half is
heard without waking on ordinary conversation. The name on its own no longer
wakes it at all.

The greeting can be "hey", "hi", "ok" or "okay", and is matched loosely enough to
survive coming back as "hay" or run together as "heyfalcon". The name is matched
by edit distance plus known mishearings ("Falken", "Vulcan"), with real words
inside that radius — *fallen*, *salmon*, *bacon*, *talon* — blocked outright.

Both halves were chosen by testing them through the en-IN recognizer rather than
by guessing: "hey falcon" came back verbatim in every utterance, from all three
Indian English voices, in every phrasing tried.

Change it with `"wakePhrase": "hey jarvis"` in `config.json`. A single word there
works too, and falls back to the old looser matching.

While asleep it stays silent and writes nothing down. Speech still shows on the
interim line as it is heard, so you can see the microphone is alive, but it
leaves no trace in the transcript — a room full of half-heard fragments reads as
if it were still working. Set `"showIgnored": true` if you are debugging
recognition and want to see everything it picks up.

Set `"wakeWord": false` to go back to answering everything it hears.

### Waking without holding the microphone

By default the app releases the microphone whenever it sleeps, so it holds no
audio device between conversations — no indicator, nothing in Control Center.
Set `"holdMic": true` to keep it open and listen for the wake phrase instead,
which is how any third-party app has to hear its own name, and why the orange
indicator then stays lit the whole time it runs.

"Hey Siri" does not work that way. Its detector runs on dedicated low-power
silicon outside the normal audio path, which is how it can listen continuously
without holding the microphone or lighting the indicator. **There is no API to
that** — it is reserved for Siri, and no third-party app can register a wake word
with it.

What you can do is let Siri do the listening. Siri already runs Shortcuts by
name, so a Shortcut that pokes this app turns Apple's wake word into yours:

```sh
npm run siri
```

That installs the hook and prints the four steps to bind it to a Shortcut, which
has to be done by hand — Shortcuts are signed, so no script can create one. After
that, **"Hey Siri, falcon"** wakes it.

Until the Shortcut exists there is no way in but typing, so the app says so at
startup rather than silently ignoring you.

The trade-off is real and there is no way around it: **with `holdMic` off,
nothing you say can wake it.** Siri wakes it, or the buttons in the window, or
typing. Something has to be listening for a voice to trigger anything, and if it
is not this app then it is Siri.

| | `holdMic: false` (default) | `holdMic: true` |
|---|---|---|
| wake by voice | "Hey Siri, falcon" | "hey falcon" |
| mic while asleep | released | held open |
| indicator when idle | off | on |
| works without Siri | no | yes |

### Note mode

`hey falcon listen` captures the conversation without speaking. On `hey falcon stop` it
writes `notes/YYYY-MM-DD/<title>.md` in the working directory — a day per folder,
one titled file per discussion — then reads a two-sentence version aloud.

The file holds a summary of what was discussed, decisions, and action items. The
raw transcript is deliberately not kept: it is mangled speech that nobody
rereads, and the summary is what the discussion was captured for.

If the discussion mentions a ticket, issue or pull request, it looks the
reference up before writing and adds a **References** section giving each one's
title and state, so the notes say what the issue actually is rather than
repeating a number back at you. Spoken forms count too — "issue four twenty one"
and "hash 421" are both references. Anything it cannot resolve is marked as
unresolved rather than guessed at.

### To-dos and issues

Anything you say to the list is a command, not a question — it never costs a turn
and never reaches the model.

| you say | it does |
|---|---|
| **"hey falcon, add a todo to ship the redis fix"** | adds it |
| **"remind me to update the docs"** | adds it |
| **"what are my todos"** | reads the open ones back, numbered |
| **"todo two is done"** | completes the second open item |
| **"delete todo two"** | drops it |
| **"make todo two a github issue"** | files it with `gh`, and remembers the number |

The numbers are positions in the open list, in the order it reads them out — so
the number you just heard is the number you can say back. Completing an item
renumbers the rest, which is why it tells you the count after every change.

Note mode feeds this: action items from a discussion are added to the list
automatically when the summary is written. Filing an issue never is — it is
public and awkward to withdraw, so it only happens when you ask for it by name
or click the button.

The list lives in `todos.json` in the working directory, so it belongs to the
project you are talking about and outlives the app. The window shows the same
list with buttons for done, remove, reopen, and file-as-issue.

Filing needs the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`)
and a working directory that is a GitHub repository. If either is missing it says
so out loud rather than failing quietly.

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

Then set `"piperVoice": "en_US-ryan-high"` in `config.json`. Any locale works, not
just American English — `en_GB-alba-medium`, `de_DE-thorsten-high` and so on.

**If anything fails.** Run `npm run doctor`. It writes
`opus-voice-diagnostics.txt` with this machine's versions, the exact download URL,
whether that URL is reachable from here, and the full output of the step that
failed — which is the thing worth sending when asking for help.

**If the download fails.** Re-run it. The model is downloaded to a scratch file
and only moved into place once complete, so an interrupted transfer is detected
and replaced rather than left behind as a half-model that quietly breaks
synthesis. If the machine cannot reach huggingface at all — blocked, proxied or
rate-limited — point it somewhere else:

```sh
PIPER_VOICES_URL=https://your-mirror/piper-voices ./scripts/install-piper.sh
```

The URL is the root of the voice tree; the script appends
`<family>/<locale>/<name>/<quality>/<voice>.onnx` to it. Copying that folder from
a machine that already has it works too.

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
| `holdMic` | `false` | keep the mic open while asleep to hear the wake phrase |
| `siriPhrase` | `falcon` | the Shortcut's name, said as "hey siri, falcon" |
| `wakeWord` | `true` | require the wake phrase before it answers |
| `wakePhrase` | `hey falcon` | what wakes it |
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
