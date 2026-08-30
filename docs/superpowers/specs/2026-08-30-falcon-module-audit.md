# Falcon — module audit

*30 August 2026. An inventory of every module in the repository, written before
any deepening work begins, so the order we work in is chosen rather than
stumbled into.*

The app is being renamed from **opus voice** to **Falcon** and turned into a real
desktop app. Neither of those is the subject of this document. This is the map:
what each module does, what it exposes, what it depends on, what condition it is
actually in, and what "deepen this" would mean for it. The ranked shortlist at
the end is a recommendation, not a decision.

Read on `d5b86e8`. Line counts are from that commit.

---

## The shape of the system

Three processes, and the reason there are three is worth stating once because it
explains most of the boundaries below.

```
  Falcon.app (Swift, menu bar)         ← owns the bundle identity, so macOS has
    │                                    one thing to attach mic permission to
    ├── node src/index.mjs             ← the orchestrator: every decision
    │     ├── bin/voiceio (Swift)      ← owns the microphone, both recognizers,
    │     │                              and all playback — one audio graph
    │     ├── vendor/py whisper_server ← second-opinion transcription
    │     ├── vendor/py piper_server   ← neural speech
    │     └── claude --print (stream)  ← the model, one long-lived session
    └── WKWebView → 127.0.0.1:4477     ← the window, served by node
```

Audio is one process because the voice-processing unit only cancels echo from
audio rendered through its own engine — a second process making sound would make
the app interrupt itself. The app is the parent of the tree because TCC attaches
permission to a bundle identity. Everything else follows from those two facts.

---

## Node modules — the pipeline

### `src/voice.mjs` — 126 lines
**Does** Wraps `bin/voiceio` as an `EventEmitter`: spawns it, speaks JSON lines
at it, re-emits its events (`ready`, `partial`, `final`, `utterance`, `bargein`,
`speech-start/end`, `level`, `standby`, `warn`, `error`, `exit`).
**Exposes** `class VoiceIO` — `configure`, `standby`, `speak`, `pcmStart/pcm/pcmEnd`, `stop`, `listen`, `close`, `restart`.
**Depends on** `bin/voiceio`, overridable via `OPUS_VOICE_IO_BIN`.
**Condition** Good. Hardened last week: `stdin` has an error listener (an
unlistened pipe throws at the process), and `restart()` survives a headphone
unplug taking the audio device with it.
**Tests** `voice.test.mjs`.
**Deepening** Little needed. The one gap is that `restart()` re-emits `ready`,
and the restart *policy* — three deaths in a minute is fatal — lives in
`index.mjs` rather than here.

### `src/whisper.mjs` — 117 lines
**Does** Keeps a Python Whisper process resident (model load costs seconds) and
transcribes one turn's PCM per call. Every failure resolves to `''` so the caller
falls back to Apple's text.
**Exposes** `available()`, `class Whisper` — `transcribe(pcm, sampleRate)`, `close()`.
**Depends on** `vendor/py/bin/python`, `scripts/whisper_server.py`.
**Condition** Good, with one real gap: **`#die()` is terminal.** Once the child
dies, `this.dead` is set for the life of the process and every later turn
silently uses Apple's text. `voice.mjs` and `claude.mjs` both restart; this does
not. The warning is emitted once, an hour before you notice the accuracy drop.
**Tests** `whisper.test.mjs`.
**Deepening** A restart policy matching the other two children. Possibly a
warm-standby second process, since the model reload is the expensive part.

### `src/transcript-guard.mjs` — 76 lines
**Does** Refuses turns nobody spoke. Two guards: a microphone peak floor
(`MIN_PEAK = 0.02`) and a stock-phrase/looped-output check for Whisper's
silence hallucinations ("Thanks for watching!").
**Exposes** `MIN_PEAK`, `isHallucination(text)`, `acceptable(text, peak)`.
**Depends on** Nothing.
**Condition** Good. Fails closed on an unreadable level, which is the right
default and is commented as such.
**Tests** `transcript-guard.test.mjs`.
**Deepening** None obvious. The phrase list will need occasional additions.

### `src/chunk.mjs` — 127 lines
**Does** Cuts streamed model text into speakable sentences at boundaries, so
speech starts while the model is still generating; strips markdown that is
punctuation on a page and noise in the ear.
**Exposes** `sanitize(text)`, `class SpeechChunker` — `push`, `flush`, `reset`.
**Depends on** Nothing.
**Condition** Good. Handles abbreviations, initials, decimals, unclosed code
fences. The `firstMinChars` / `minChars` split is a real latency decision.
**Tests** `chunk.test.mjs`.
**Deepening** None. This module is finished.

### `src/wake.mjs` — 231 lines
**Does** Wake-phrase detection and spoken mode commands. Edit distance plus an
alias list plus a blocklist of real words inside the fuzz radius.
**Exposes** `setWakePhrase`, `wakePhrase()`, `parseWake(text)`, `parseCommand(text)`.
**Depends on** Nothing.
**Condition** Good for the shipped phrase, **weak for any other.**
`WAKE_ALIASES` (`vulcan`, `falken`, `foulcon`) and `NOT_WAKE` (`fallen`,
`salmon`, `bacon`…) are hardcoded to *falcon* and `setWakePhrase()` does not
touch them. Configure `"wakePhrase": "hey jarvis"` as the README invites, and you
get jarvis matched by edit distance with falcon's aliases still live and no
blocklist of its own. It degrades quietly rather than breaking.
**Tests** `wake.test.mjs`.
**Deepening** Make the alias and blocklist sets a property of the configured
name rather than module constants — either derived, or a config key. This is
also the module that decides what "Falcon" means as a spoken identity.

### `src/claude.mjs` — 210 lines
**Does** One long-lived `claude --print` process in streaming-JSON mode for the
whole conversation. Emits `delta`, `thinking`, `tool`, `text-end`, `turn-end`.
**Exposes** `CLAUDE_FALLBACKS`, `resolveClaudeBin()`, `class ClaudeSession` — `send`, `restart`, `close`.
**Depends on** the `claude` CLI, `style.mjs` for the system prompt.
**Condition** Good, and recently the site of three real bugs, all fixed: bare-name
spawn under launchd's PATH, a failed spawn emitting `error`/`close` but never
`exit` (wedging `busy` forever), and stderr being dropped so a rate-limit death
was silent.
**Tests** `claude.test.mjs`, plus e2e restart cases.
**Deepening** `restart()` is a fresh start, not a resume — the conversation dies
with the process, and `--no-session-persistence` means nothing on the CLI side
holds it either. `history.mjs` has the transcript; replaying it into a new
session on restart would turn "that last answer is gone" into a recoverable
event. Also: model and effort are fixed at launch.

### `src/piper.mjs` — 102 lines
**Does** Local neural TTS as a resident subprocess, streaming PCM back tagged
with an utterance id.
**Exposes** `findVoice`, `available`, `class Piper` — `synthesize(id, text)`, `close()`.
**Depends on** `vendor/py`, `vendor/voices/*.onnx`.
**Condition** Good; `stdin` error guarded like the others.
**Tests** `piper.test.mjs`.
**Deepening** No restart — a Piper death falls back to the Apple voice
permanently (in `speaker.mjs`). Same shape of gap as Whisper, lower stakes,
because the fallback is audible and therefore self-reporting.

### `src/speaker.mjs` — 124 lines
**Does** Chooses the synthesis engine and owns the Piper utterance queue: one
utterance at a time, audio from an interrupted utterance dropped rather than
played late.
**Exposes** `class Speaker` — `say`, `stop`, `close`, `name`.
**Depends on** `voice.mjs`, `piper.mjs`.
**Condition** Fine. The `onWarn` constructor argument exists because a missing
Piper voice is reported from inside the constructor and a listener attached
afterwards never hears it — a subtle thing, correctly handled.
**Tests** None directly.
**Deepening** Tests. Otherwise sound.

---

## Node modules — surfaces

### `src/bus.mjs` — 159 lines
**Does** The conversation as data, so more than one surface can render it. Holds
entries, mode, status, partial, todos, levels; emits small serializable patches;
`snapshot()` for a client that connects late.
**Exposes** `class Conversation` — `banner`, `hearing`, `you`, `opus`, `heard`, `ignored`, `system`, `warn`, `error`, `tool`, `interrupted`, `setMode/Status/Todos/Level/Speaking`, `snapshot`.
**Depends on** Nothing. Knows nothing about sockets, ANSI or the DOM — correctly.
**Condition** Good. Capped at 400 entries with monotonic ids.
**Tests** `bus.test.mjs`.
**Deepening** The `opus(text, first)` method and the `role: 'opus'` entries are
the rename's deepest reach into the data model — the window, the history files
on disk and the menu bar all key off that string.

### `src/view.mjs` — 122 lines
**Does** One call site, two-and-a-half surfaces. Every event the orchestrator
reports goes through here and fans out to the terminal UI, the conversation bus
and the on-disk history.
**Exposes** `makeView(ui, conversation, history)`.
**Condition** Good, and load-bearing: it is what stops the window and the
terminal drifting apart.
**Tests** None (it is a fan-out; the e2e suite exercises it indirectly).
**Deepening** None. Add surfaces here, not around it.

### `src/server.mjs` — 211 lines
**Does** Loopback HTTP for the window: static files from `ui/`, SSE at
`/events`, `POST /command`, and `/library/*` for past chats and notes. Token
generated at startup, in the URL query and the `x-opus-token` header.
**Exposes** `class UiServer` — `listen()`, `url`, `close()`.
**Depends on** `session.mjs`, `history.mjs`, `notes.mjs`, `ui/`.
**Condition** Good. Port stepping on `EADDRINUSE`, request draining before every
early exit (an unread body resets the *next* keep-alive request), path traversal
blocked in both `#static` and the library readers.
**Tests** `server.test.mjs`.
**Deepening** The library is list-and-read only; there is no search endpoint, so
the window filters client-side over titles and previews. Also no CSP on the
served page.

### `src/session.mjs` — 61 lines
**Does** Publishes where the running session can be found, at mode 0600, written
through a scratch file and renamed. A file rather than argv because the URL
carries the token and argv is world-readable.
**Exposes** `DIR`, `DEFAULT_FILE`, `write`, `read`, `clear`.
**Condition** Good. `read()` checks the pid is alive, so a crashed run's file
does not point a window at a dead port.
**Tests** `session.test.mjs`.
**Deepening** None. Pure rename surface (`~/.opus-voice`).

### `src/ui.mjs` — 194 lines
**Does** Terminal rendering: one mutable live line at the bottom, permanent
transcript lines above, a six-column gutter so every speaker's text starts at the
same column.
**Exposes** `class Ui` — `banner`, `print`, `you`, `opus`, `note`, `heard`, `ignored`, `mode`, `warn`, `error`, `hearing`, `spin`, `clearLive`, `close`.
**Condition** Good. Word wrapping is hand-rolled because letting the terminal
hard-wrap destroys the column.
**Tests** None.
**Deepening** Hardcodes the product name in the banner and `"hey falcon"` as
both default phrase and hint. Rename surface, otherwise finished.

---

## Node modules — features

### `src/notes.mjs` — 236 lines
**Does** Note mode: capture a discussion silently, then summarize it. Holds the
`SUMMARY_PROMPT` (which instructs the model to resolve spoken ticket references
with `gh`), writes `notes/<date>/<title>.md`, lists and reads notes for the
window, and splits the model's reply into `TITLE:` / `ACTION:` / `SPOKEN:` parts.
**Exposes** `SUMMARY_PROMPT`, `class Notes`, `listNotes`, `readNote`, `slug`, `splitSummary`.
**Condition** Good. The transcript is deliberately not written — mangled speech
nobody rereads. Filename collisions are handled.
**Tests** `notes.test.mjs`, plus four e2e cases.
**Deepening** `listNotes` reads and parses every note file on every request. Fine
at hundreds, not at thousands.

### `src/history.mjs` — 203 lines
**Does** Conversations kept on disk under `~/.opus-voice/chats/<day>/`, one JSON
file per conversation, flushed on every turn because ctrl-c is the normal exit.
Deliberately not in the working directory: a transcript of everything you say to
your machine does not belong in somebody's repo.
**Exposes** `DIR`, `class History` — `begin`, `you`, `opus`, `end`; `list()`, `read(id)`.
**Condition** Good. Atomic writes, 0600, traversal-checked reads.
**Tests** **None.** The only feature module with disk-format responsibility and
no unit test.
**Deepening** Tests first. Then: `#flush` rewrites the whole record per turn
(fine at this scale); `list()` parses every file (same ceiling as notes); and
there is no search, which is the obvious next thing to want from a year of
conversations.

### `src/todos.mjs` — 129 lines / `src/todo-commands.mjs` — 126 lines
**Does** The list, kept as `todos.json` in the working directory so it survives
the app and is readable without it. Ordinals — positions in the open list — are
what you say out loud. The commands module parses spoken instructions, loose
about form ("two do", "todo 2") and strict about intent (a sentence only counts
if it names the list, so "delete the branch" stays a question).
**Exposes** `class Todos` (`add`, `complete`, `reopen`, `remove`, `linkIssue`, `byOrdinal`, `snapshot`, `spoken`); `parseTodo`, `toNumber`.
**Condition** Good. Rule ordering is commented where it matters (`add` last, or
it swallows "make todo two a github issue").
**Tests** `todos.test.mjs` plus e2e.
**Deepening** None pressing.

### `src/github.mjs` — 76 lines
**Does** Files a to-do as a GitHub issue via the `gh` CLI. Arguments as an array
so a to-do containing backticks is text, not syntax. Errors translated into
something worth saying out loud.
**Exposes** `createIssue({title, body, cwd})`, `available(cwd)`.
**Condition** Fine — but **`available()` is dead code.** It exists so the window
can disable the button when filing is impossible; nothing imports it. The button
is always live, and a click in a non-repo folder fails after the fact, out loud.
**Tests** None.
**Deepening** Either wire `available()` up (it needs a `/library`-style endpoint
or a field on the banner) or delete it.

### `src/style.mjs` — 160 lines
**Does** Who it is when its words are spoken. The `SYSTEM_PROMPT` is the persona
— talk like a colleague, think privately, never speak markup, offer long answers
rather than dumping them. Plus thinking-beat fillers split by whether you asked a
question or gave an instruction, and tool-call narration.
**Exposes** `SYSTEM_PROMPT`, `classify(text)`, `narrate(tool, first)`, `nextFiller(text)`.
**Condition** Good, and the highest-leverage file in the repo for how the thing
*feels*. The persona lives in the prompt rather than in post-processing, for the
stated reason that a filter can only remove.
**Tests** `style.test.mjs`.
**Deepening** This is where Falcon becomes a character rather than a wrapper —
the assistant now answers as `falcon`, and the prompt currently says nothing
about having a name.

### `src/config.mjs` — 105 lines
**Does** Defaults, then `config.json` from the repo root, then `--flag`
overrides. Booleans stand alone so `--ui` never swallows the next argument.
**Exposes** `DEFAULTS` (40 keys), `loadConfig(argv)`, `resolveWorkdir(config)`.
**Condition** Adequate, with sharp edges. An unknown `--flag` is silently
ignored (`if (!(key in config)) continue`); so is an unknown key in
`config.json`, and so is a value of the wrong type — `"rate": "fast"` becomes
`NaN` downstream with no complaint. Config lives in the repo root, which means
the bundled app is configured by editing the working tree.
**Tests** **None** — and `OPUS_VOICE_IGNORE_CONFIG` exists precisely so the
suite doesn't read the developer's local file, which tells you the coupling was
already felt.
**Deepening** Validation with named errors; a config location outside the repo;
and this is the module a Settings window would be built on.

### `src/trigger.mjs` — 70 lines
**Does** Being woken from outside. With `holdMic: false` the microphone is
released while asleep, so nothing the app can hear can wake it — something else
must. The trigger is a file (`~/.opus-voice/wake`), watched by `fs.watch` *and*
polled, because a missed wake is the failure that makes it look broken.
**Exposes** `DIR`, `FILE`, `HOOK`, `class Trigger` (emits `wake`).
**Condition** Good, and **more load-bearing than its size suggests**: the Siri
Shortcut and the AirPods squeeze both arrive through this one file.
**Tests** None directly; e2e covers the wake file including the stale-file case.
**Deepening** This is the seam the desktop app hooks into. Today a wake is a
touch with no payload — "summon the window" needs either a second signal or a
payload here.

### `src/siri.mjs` — 48 lines
**Does** Checks that a Shortcut with the configured name actually exists, because
Siri finds a Shortcut by name and nothing else — a correct Shortcut under the
wrong name is invisible, and the symptom is an app that ignores you. Names the
"Run Shell Script" default explicitly.
**Exposes** `listShortcuts()`, `checkShortcut(phrase)`.
**Condition** Fine.
**Tests** None.
**Deepening** None.

### `src/index.mjs` — 837 lines ⚠️
**Does** Everything else. Wiring of all ten modules above; the mode machine
(asleep/awake/chat/note) and its sleep timer; the turn lifecycle (filler timing,
barge-in, interruption, queued utterance); `handleUtterance` — the single funnel
every input passes through, spoken, typed or clicked; to-do command dispatch and
issue filing; the note-mode summary round trip; the window/server lifecycle; the
external wake trigger; restart policies for both children; audio dumping for
debugging; and shutdown.
**Condition** **The one module that is too big.** It is not badly written — the
comments are the best in the repo and every non-obvious branch explains the bug
that put it there — but eight distinct responsibilities share one file and one
scope, communicating through module-level mutable state (`mode`, `turn`,
`started`, `pendingSummary`, `lastUtterance`, `voiceRestarts`, `claudeRestarts`).
**Tests** No unit test. `e2e.test.mjs` (691 lines, 32 cases) drives the real
binary with stubs and covers it well behaviourally — which is why the size has
not hurt yet.
**Deepening** The highest-value refactor available. Natural seams: the mode
machine, the turn lifecycle, command routing (`handleUtterance` / `handleCommand`
are two doors to the same room), child restart policy, and window supervision.
The desktop-app work will have to touch several of these.

---

## Swift — the audio daemon

### `swift/VoiceIO.swift` — 1265 lines ⚠️
**Does** The microphone, both recognizers, endpointing, synthesis, external PCM
playback, metering in both directions, standby, and input-device selection — in
one process so they can share one audio graph.
**Condition** Large, but with the genuinely testable parts already extracted
(below) and tested. What remains is device-bound: the endpoint timer's policy,
the self-echo filter, the standby teardown/rebuild, the two recognizer paths.
The comments here are archaeology of real failures — why echo cancellation is off
by default (it costs consonants), why the transcriber is rebuilt after standby
(it never produces another result otherwise), why speech ending by barge-in must
*not* clear the buffer (it throws away the words that caused the barge-in).
**Tests** Only via the extracted types.
**Deepening** Two more extractions are plausible: the endpoint/turn-taking policy
(currently a `DispatchSourceTimer` closure making three decisions inline) and
recognizer selection. Both are pure enough to test.

### `swift/TurnAssembler.swift` — 83 lines + tests
**Does** Assembles one spoken turn from transcriber results — finalized text
accumulates, volatile text replaces. Extracted because "it was the part that was
wrong, and it was wrong in a way no amount of reading it caught."
**Condition** Good. One vestige: `base` is set to `0` in both `endBarrier()` and
`reset()` and never to anything else, so `dropFirst(base)` in `running` is now a
no-op left over from the baseline-arithmetic approach the file's own comment says
was abandoned.
**Tests** `TurnAssemblerTests.swift`.

### `swift/UtteranceBuffer.swift` — 143 lines + tests
**Does** Holds the audio of one turn for the second-opinion recognizer. A class,
not a struct, because the audio thread appends thousands of times a second.
**Condition** Good — with **`trimToSpeech()` dead**. It is 40 lines, carefully
documented (a fixed window cannot win; walk back through the speech to the first
real silence), and tested — and nothing calls it. `VoiceIO` calls
`trimToLast(seconds: 30.0)`, whose own comment concedes it is "a ceiling, not a
cut". This looks like a better approach that was built, tested, and never wired
in.
**Tests** `UtteranceBufferTests.swift`.
**Deepening** Decide: wire `trimToSpeech` in behind a flag and measure it against
the 30-second ceiling, or delete it. Leaving tested dead code implies it is live.

### `swift/Utterance.swift` — 44 lines + tests
**Does** Two pure predicates: `isSpeech` (letters or digits in any script) and
`isCompleteThought` (a trailing full stop only counts once there is enough there
to be a thought — "F." is a syllable caught mid-flight).
**Condition** Good. Small, tested, and each function traces to a specific bug.

### `swift/InputDevice.swift` — 122 lines
**Does** CoreAudio device enumeration and default-input switching. Prefers the
built-in mic over Bluetooth, because opening the mic with AirPods connected
drops them into hands-free mode — measured at 3.6% of energy above 6kHz, which
is a phone call, and both recognizers produced nonsense from it.
**Condition** Good. Restores the previous device on every exit path.
**Tests** None (device-bound).

### `swift/Keepalive.swift` — 65 lines
**Does** Holds a silent looping WAV open so the AirPods have a stream to
control — with no stream the bud never emits the command at all. `AVAudioPlayer`
and not `AVAudioEngine`, because an engine opens duplex I/O, which forces SCO,
where a single press means "end call" — defeating the exact thing this enables.
**Condition** Good, and the single most non-obvious piece of the squeeze path.
**Tests** None (device-bound).
**Note** Directly load-bearing for the desktop app work.

---

## Swift — the app

### `swift/OpusVoiceApp.swift` — 374 lines
**Does** The menu bar app: status item and menu, the `Orchestrator`, the
headphone wake watcher, an on-demand `WKWebView` window, an SSE client following
the same event stream the window reads (so glyph and window cannot disagree), a
login-item registration that fires exactly once, and a second writer into node's
log file.
**Condition** Works, and is doing five jobs. `NSApp.setActivationPolicy(.accessory)`
plus `LSUIElement` is what makes it a background utility rather than an app.
**Tests** Only `MenuBarState`.
**Deepening** **This is the desktop-app module.** Dock icon, real app menu,
window lifecycle, About/Settings, and the squeeze summoning the window all land
here — most likely by splitting it into a status-item controller, a window
controller and a session client.

### `swift/Orchestrator.swift` — 160 lines
**Does** Owns the node process. Spawns it with the recorded node path, logs to
`~/.opus-voice/opus-voice.log` (a file, not a pipe — an unread pipe fills and
blocks the child), polls for the session file, and stops restarting after three
deaths in a minute rather than hiding a crash loop behind a flickering menu bar.
**Condition** Good.
**Tests** None.
**Deepening** None pressing.

### `swift/Environment.swift` — 120 lines + tests
**Does** Resolves where everything is *before* anything is spawned, because a
login-launched process inherits no useful PATH. The repo root and node path are
recorded into `Info.plist` at bundle time; the project directory comes from
`config.json`. Every failure is a named `LaunchProblem` whose message says what
to go and fix.
**Condition** Good. Also holds `shouldReloadWindow`, which exists because a
window outliving a session restart holds a dead token and freezes on its last
frame.
**Tests** `EnvironmentTests.swift`.

### `swift/RemoteCommands.swift` — 128 lines
**Does** The squeeze. AirPods send AVRCP commands that macOS routes to the Now
Playing app — never HID media keys, measured as 0 events across three sessions on
the HID path against every squeeze on this one. Claims the Now Playing role,
maps a configured gesture (`playPause` / `next` / `previous`) to touching the
wake file, and optionally forwards the command to Spotify or Music by AppleScript
so the music still responds.
**Condition** Works. Two soft edges: claiming Now Playing takes the role from
whatever had it (inherent — the system delivers to exactly one app), and the
AppleScript forward needs Automation permission, which if refused fails quietly
after trying both players.
**Tests** None.
**Deepening** **The other half of the desktop-app module.** `poke()` currently
has one effect — touch the wake file. "Squeeze summons the window" needs a second.

### `swift/VoiceApp.swift` — 164 lines
**Does** A standalone window binary. Reads the session URL from the 0600 file
(never argv), opens a `WKWebView`, goes full screen unless `OV_FULLSCREEN=0`,
and quits when the window closes — which ends the node session that spawned it.
**Condition** Works, and **substantially duplicates** the window code inside
`OpusVoiceApp.swift`: two `WKWebView` setups, two `NSWindow` configurations, two
navigation policies, both using the `opus-voice` frame autosave name so they
fight over the same saved frame.
**Deepening** Collapse the two into one window controller as part of the desktop
app. `npm run app` is the only thing that needs this binary to exist separately.

### `swift/MenuBarState.swift` — 24 lines + tests
**Does** Which SF Symbol the status item draws, ordered by what a person most
needs to know: broken, then mid-turn, then mode. "The only part of the app that
is a pure decision."
**Condition** Good.

---

## The window

### `ui/index.html` (92) · `ui/app.js` (728) · `ui/style.css` (574)
**Does** The desktop window: a live view with the particle field at centre, a
to-do rail, an "Upcoming" rail, and library views (Today / Chats / Notes) with
list-and-read panes. Renders pushed state, fetches history on demand, posts
commands back.
**Condition** Recent and substantial. Careful in places that matter: the level
stream (30 patches a second) never touches the DOM — the field reads the value on
its own animation frame; `prefers-reduced-motion` holds the field still; the wake
phrase is built as text nodes rather than `innerHTML` because it comes from
config.
**Tests** None for the page itself; `server.test.mjs` covers the endpoints.
**Deepening** `app.js` is four modules in one file (views, library, to-dos, the
canvas field, transport). The "Upcoming" rail is a **placeholder** — there is no
calendar behind it, only the explanatory note. And the whole page is the surface
the desktop app is about to make primary.

---

## Build, packaging, install

| File | Lines | Condition |
|---|---|---|
| `build.sh` | ~70 | Builds three binaries. `voiceio` links `Info.plist` into `__TEXT` (a plain CLI without it is killed the moment it touches the mic); the two app binaries are optional and their failure must not stop the daemon shipping. Sound. |
| `scripts/bundle.sh` | ~110 | Builds `Opus Voice.app` as a **thin launcher** — the binary plus an `Info.plist` recording the repo path and node path. Runs against the working tree in place, so it is a developer's app, not a distributable one. Verifies rather than assumes, and refuses to finish if `config.json` has no `dir`. |
| `install.sh` | 11.7 KB | First-run setup. |
| `scripts/doctor.sh`, `install-piper.sh`, `install-whisper.sh`, `measure-whisper.sh`, `siri-setup.sh`, `mic-test.mjs`, `voices.mjs` | — | Support scripts; `measure-whisper` is how the model choice was actually decided. |
| `scripts/piper_server.py`, `whisper_server.py` | ~70 each | Resident model servers. |

**Decision the desktop app forces:** the bundle is thin on purpose (copying
`vendor/` would duplicate 231 MB into `/Applications`, and every `git pull` would
need a rebundle). A real Falcon.app either stays a launcher for a checkout — fine
for one user, impossible to hand to anyone — or becomes self-contained. That
choice belongs in the desktop-app spec, not here.

---

## Test coverage

**14 node test files, 1844 lines.** `e2e.test.mjs` alone is 691 lines and 32
cases, driving the real `index.mjs` against stub binaries — which is why the
untested modules have not hurt.

| Tested | Untested |
|---|---|
| bus, chunk, claude, notes, piper, server, session, style, todos (+ todo-commands), transcript-guard, voice, wake, whisper, e2e | **config**, **history**, speaker, view, ui, trigger, siri, github, index (unit) |

**Swift: 5 of 18 files tested** — `MenuBarState`, `Environment`, `Utterance`,
`TurnAssembler`, `UtteranceBuffer` — via `swiftc` directly rather than XCTest or
SPM, run by `scripts/test-swift.sh`. Everything untested is device-bound or an
app entry point, which is defensible, though `Orchestrator` and `RemoteCommands`
have testable logic inside them.

The two gaps that matter: **`config.mjs`** (parses user input, silently ignores
what it doesn't recognise, no tests) and **`history.mjs`** (owns an on-disk
format, no tests).

---

## Loose ends found while reading

Small, real, and none of them urgent:

1. **`UtteranceBuffer.trimToSpeech()` is never called** — 40 lines of documented,
   tested, dead code that reads as live. `VoiceIO` uses `trimToLast(30.0)`.
2. **`github.available()` is never imported** — it exists so the window can
   disable the button; nothing wires it up.
3. **`TurnAssembler.base` is always 0** — vestigial from the abandoned baseline
   approach; `dropFirst(base)` is a no-op.
4. **`wake.mjs` alias/blocklist sets are hardcoded to "falcon"** — configuring a
   different phrase degrades quietly.
5. **`whisper.mjs` never restarts** — one death and every later turn silently
   uses the worse recognizer.
6. **Two window implementations** — `VoiceApp.swift` and the window inside
   `OpusVoiceApp.swift`, sharing a frame autosave name.
7. **The "Upcoming" rail is a placeholder** with no calendar behind it.
8. **`config.mjs` silently ignores unknown keys, unknown flags and wrong types.**

---

## Recommended order

A recommendation. Rank it differently if you disagree — the inventory above is
the part that matters.

**0. The rename to Falcon.** Not a deepening; a prerequisite. It touches nearly
every module (96 occurrences of "opus voice", 50 of "opus-voice", 29 of
"opusvoice", 35 `OPUS_VOICE_*` env vars, 7 `x-opus-token`, the `opus` role in the
bus and in every history file on disk, `~/.opus-voice`, the bundle id, three
binary names). Doing it first means every later module lands clean; doing it
later means touching each module twice. Costs: the bundle-id change resets the
TCC grants (mic and speech prompt again, and will finally say "Falcon"), and
`~/.opus-voice` → `~/.falcon` needs a migration or existing chats, notes and the
session file are orphaned.

**1. The Falcon desktop app.** `OpusVoiceApp.swift` + `RemoteCommands.swift` +
`VoiceApp.swift` + `trigger.mjs`: dock icon, real menus, a window controller
shared by both entry points, and the squeeze summoning the window as well as
waking the session. This is what was asked for, and it is well-bounded once the
rename is out of the way.

**2. `src/index.mjs` — split it.** 837 lines, eight responsibilities, module-level
mutable state, no unit test. It is the file every future module change has to go
through, and the desktop-app work will already have touched its edges. The e2e
suite is the safety net that makes this refactor safe to do.

**3. `ui/app.js` — split it, and finish the window.** 728 lines and four
responsibilities, about to become the primary surface. The "Upcoming" rail either
gets a calendar or gets removed.

**4. Reliability round.** Whisper restart; the Piper fallback made visible; the
Claude restart replaying history so "that last answer is gone" stops being true.
One coherent pass over the three child processes.

**5. `config.mjs` — validation, and a home outside the repo.** Prerequisite for
any Settings UI, and the fix for a class of silent misconfiguration.

**6. Tests for `history.mjs` and `config.mjs`.** Could ride along with 4 and 5
rather than being its own step.

**7. The loose ends above.** An afternoon, mostly deletions.
