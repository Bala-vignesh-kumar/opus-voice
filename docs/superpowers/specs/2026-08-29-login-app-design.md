# opus voice as a login app

Design for packaging opus voice as `Opus Voice.app`: a menu-bar-only macOS
bundle that starts itself at login, sits asleep in the menu bar, and is woken by
Siri exactly as the terminal version is today.

Status: approved in brainstorming, 2026-08-29. Not yet implemented.

## The problem

`npm start` and `npm run app` both assume a person in a terminal who has just
typed a command in a project directory. Three things follow from that assumption
and every one of them breaks at login:

- **There is no working directory.** `resolveWorkdir()` reads `INIT_CWD`, which
  is where npm was invoked. A process started by launchd has no meaningful cwd,
  and the whole product is organised around "the project you are talking about" —
  `todos.json`, `notes/`, and the files Claude is allowed to edit all live there.
- **There is no PATH.** A login-launched process inherits a minimal environment
  with no Homebrew, no nvm, no `/opt/homebrew/bin`. `node` is not on it. This is
  the same failure already fixed once in `bb1c1d8` for the Siri Shortcut hook.
- **There is no terminal to attribute permissions to.** Microphone and Speech
  Recognition are currently granted to Terminal or iTerm, which is why the
  permission prompt names the wrong application and the README has to explain it.

## Decisions

Settled during brainstorming. Recorded here because each one closes off
alternatives that would otherwise look reasonable later.

| Decision | Choice | Why |
|---|---|---|
| Working directory | A fixed project folder from `config.json` | Predictable, and the blast radius of a resident agent with shell access should never depend on remembered history. |
| Surface | Menu bar only, no dock icon, no window at login | It sleeps by default and is woken by Siri; it spends most of its life doing nothing visible. A dock icon and a window every morning is noise. |
| `permissionMode` | `bypassPermissions`, unchanged | The trade-off was raised explicitly and accepted: this is the same capability the terminal app has today, and splitting the default between two surfaces would make behaviour depend on how it was launched. |
| Login mechanism | `SMAppService`, app as parent process | One login item, one quit path, correct TCC attribution, and a toggle in System Settings the user already knows how to find. |

## Architecture

Today node is the parent and spawns the window. That inverts:

```
             before                          after
    ┌──────────────────┐            ┌────────────────────┐
    │  npm run app     │            │  Opus Voice.app    │ ← login item
    │  node src/       │            │  menu bar, Swift   │
    └────────┬─────────┘            └─────────┬──────────┘
             │ spawns                         │ spawns
      ┌──────┴──────┐                  ┌──────┴──────┐
      │ bin/voiceio │                  │  node src/  │
      │ bin/voiceapp│                  └──────┬──────┘
      └─────────────┘                         │ spawns
                                       ┌──────┴──────┐
                                       │ bin/voiceio │
                                       └─────────────┘
```

The app becomes the root of the process tree. Everything else follows from that:
a single thing for launchd to start, a single thing to quit, and one bundle
identity for macOS to attach microphone permission to.

`src/index.mjs` is not restructured. The menu bar is another surface, not another
brain — the same rule `bin/voiceapp` already follows.

### Bundle layout

```
Opus Voice.app/Contents/
  Info.plist              LSUIElement, usage strings, OVRepoRoot, OVNodePath
  MacOS/OpusVoice         new Swift binary: NSStatusItem + the WKWebView window
  _CodeSignature/
```

The bundle is a **thin launcher**. It does not contain `src/`, `ui/`, or
`vendor/`; it records the absolute path of the repository at bundle time and runs
node against the working tree in place.

That is a deliberate trade. Copying the tree in would make the app self-contained
but would duplicate `vendor/` — 231MB of Piper runtime and voice models — into
`/Applications`, and would mean every `git pull` needs a rebundle to take effect.
For a tool you are actively developing, running against the live tree is the
behaviour you want. The cost is that moving or deleting the repository breaks the
app, which the app must detect and say rather than fail silently.

Note that the README's 160-character path warning still applies: the speech
engine keeps its data path in a fixed buffer, so the repository still needs to
live somewhere shallow.

### Startup sequence

1. Login. `SMAppService` launches the bundle.
2. The status item appears immediately, in a `starting` state. Nothing below this
   point may leave the menu bar empty — an app you cannot see is an app you
   cannot diagnose.
3. Read `OVRepoRoot` and `OVNodePath` from `Info.plist`. If either is missing or
   no longer exists on disk, enter the `error` state with a menu item naming the
   exact problem, and stop. Do not guess.
4. Load `config.json` from the repo root and read `dir`. If it is empty or does
   not exist, enter the `error` state naming that. The app never falls back to
   the home directory: a voice-triggered agent with shell access should not be
   rooted somewhere nobody chose.
5. Spawn `node src/index.mjs --ui --spawn-window false --dir <dir>` with the
   repo root as cwd.
6. Wait for the session file to appear (below), with a 30-second timeout.
7. Connect to the SSE stream and reflect mode in the menu bar.

### The session file

The one genuinely new interface. `src/server.mjs` writes
`~/.opus-voice/session.json` when the server starts listening:

```json
{
  "pid": 41277,
  "port": 4477,
  "url": "http://127.0.0.1:4477/?k=3f9a…",
  "started": "2026-08-29T09:14:02.511Z"
}
```

Written with mode `0600` and removed on clean shutdown.

A file rather than argv, because **argv is world-readable**. Today node passes the
tokenised URL to `bin/voiceapp` as an argument, which means any process on the
machine can read the token out of `ps` and post commands to something allowed to
edit files and run shell commands. The token is the only thing standing between a
local process and that capability, so moving it to a `0600` file closes a real
hole and is worth doing on its own merits.

A file rather than stdout parsing, because the terminal view writes ANSI escapes
and a status line to stdout, and scraping a URL out of that would break the first
time the banner changed.

Stale files are detected by checking whether `pid` is alive. A stale file is
overwritten, never trusted.

### Node resolution

`node` is resolved once, at bundle time, by `scripts/bundle.sh`, and written into
`Info.plist` as `OVNodePath`. The app never searches `PATH` at runtime, because
at login there is no useful `PATH` to search.

If the recorded path no longer exists — node upgraded, Homebrew prefix moved — the
app tries a short fixed list (`/opt/homebrew/bin/node`, `/usr/local/bin/node`,
`/usr/bin/node`) and, if one works, updates the recorded path. If none works it
enters the `error` state saying node is missing and how to re-run the bundler.
Silently doing nothing is the one behaviour that is not allowed.

### Menu bar

An SF Symbol template image, so it inverts correctly in light and dark menu bars
and needs no asset catalog:

| state | symbol | meaning |
|---|---|---|
| asleep | `moon.zzz` | running, not listening |
| awake / chat | `waveform` | listening and will answer |
| note | `record.circle` | capturing a discussion |
| thinking / speaking | `waveform.circle.fill` | a turn is in flight |
| error | `exclamationmark.triangle` | see the menu for what broke |

Mode comes from the existing SSE stream — the app connects to `/events` with the
token from the session file and reads the same patches the window does. No new
protocol, and the menu bar cannot disagree with the window for the same reason
`src/view.mjs` exists.

Menu contents:

- **Open Window** — the existing WKWebView, pointed at the session URL
- separator
- **Discuss** / **Take Notes** / **Sleep** — POST to `/command`, identical to the
  window's buttons
- separator
- **Open Project Folder** — reveals `dir` in Finder
- **Start at Login** — checkmarked, toggles `SMAppService` registration
- **Quit opus voice** — terminates node, removes the session file

### Window ownership

`swift/VoiceApp.swift` is absorbed into the new binary rather than kept as a
separate executable. Its window code is unchanged; what changes is that closing
the window no longer ends the session, because the menu bar is now the app's
lifetime. `applicationShouldTerminateAfterLastWindowClosed` becomes `false`.

`bin/voiceapp` stays as it is for `npm run app`, so the terminal workflow is
untouched.

### Login registration

`SMAppService.mainApp.register()` on first launch, recorded in `UserDefaults` so
it happens once and never fights a user who turned it off. The **Start at Login**
menu item reads `SMAppService.mainApp.status` and toggles it, and the same switch
appears in System Settings → General → Login Items.

Requires macOS 13 or later. The project already requires an OS recent enough for
`SpeechTranscriber`, so this adds no new floor.

## Permissions

The bundle is a new TCC identity. First launch re-prompts for Microphone and
Speech Recognition even though the terminal already holds them, because macOS
tracks those grants per signing identity and the app is not the terminal.

This is a one-time cost that buys the thing the README currently apologises for:
the prompt names *opus voice* instead of *Terminal*.

**Partly resolved 2026-08-29.** The bundle was built and launched and the app
works: the menu bar shows asleep, the menu's mode commands reach the session, and
the microphone is heard. No permission prompt appeared at all, which means an
existing grant already covered it rather than a new one being requested — so the
observation confirms the app functions but does **not** settle which identity
holds the grant. On a machine with no prior grant the prompt could still name
`voiceio`. The fallback below stays documented and untested; if a fresh install
ever shows the wrong name, apply it.

The original question, kept because it is still the thing to check: audio is touched by
`bin/voiceio`, a grandchild of the app. macOS attributes a permission prompt to
the *responsible process*, which for a tree descending from a GUI bundle is
normally the bundle — but `voiceio` carries its own linked `Info.plist` and its
own ad-hoc signature, which is exactly the configuration that can make it
responsible for itself. If the prompt names `voiceio` rather than *opus voice*,
the fallback is to copy `voiceio` into `Contents/MacOS/` and sign the bundle as a
unit so there is one signature across the tree. This is checked before anything
else is built on top of it.

## Configuration

One new key, and one existing key becomes load-bearing:

| key | change |
|---|---|
| `dir` | Already exists. Now required for the app build; the app refuses to start without it rather than choosing a folder itself. |
| `sessionFile` | New. Defaults to `~/.opus-voice/session.json`. Overridable so tests never touch a real session. |
| `spawnWindow` | New, default `true`. Whether `--ui` also launches `bin/voiceapp`. |

`spawnWindow` exists because `--ui` currently means two things at once: start the
loopback server, *and* spawn the window binary. Under the menu bar app the first
is wanted at login and the second is not — a window on every login is the thing
menu-bar-only rules out. Splitting them keeps `npm run app` behaving exactly as
it does today (both, by default) while letting the app ask for the server alone.

## Error handling

Every failure below ends in a visible menu bar state with a menu item that names
the problem. None of them exits silently.

| failure | behaviour |
|---|---|
| repo root missing | `error`; menu names the recorded path and says to re-run the bundler |
| node missing | `error` after the fallback list is tried; menu says how to fix |
| `dir` unset or missing | `error`; menu names the folder from config |
| node exits unexpectedly | restart, up to 3 times in 60 seconds, then `error` |
| session file never appears | `error` after 30 seconds |
| port taken | already handled: `UiServer` steps up to 12 ports |
| window closed | menu bar continues; the session is unaffected |

## Testing

- **Session file** — unit tests alongside `test/server.test.mjs`: written on
  listen, mode `0600`, removed on close, stale pid overwritten, honours
  `sessionFile`.
- **No token in argv** — a regression test asserting the window URL is not passed
  as a command-line argument.
- **Bundle structure** — `scripts/bundle.sh` verifies its own output: bundle
  exists, `Info.plist` keys are populated with real paths, `codesign --verify`
  passes.
- **Menu bar state mapping** — pure function from a conversation patch to a
  symbol name, testable without a window.
- **Manual, documented in the README** — log out and back in, confirm the status
  item appears asleep, "Hey Siri, falcon" wakes it, the window opens, Quit
  removes the session file.

## Out of scope

Deliberately not in this design:

- Notarization, Developer ID signing, distribution outside this machine
- Auto-update
- More than one project at a time
- A custom app icon (`.icns`) — the menu bar uses an SF Symbol and there is no
  dock icon to draw
- Intel or universal binaries
- Replacing the terminal workflow, which keeps working exactly as it does today

## Risks

1. **TCC attribution lands on `voiceio`** rather than the bundle. Mitigation
   above; checked first, before anything depends on it.
2. **Running against a live working tree** means a broken commit breaks the login
   app. Accepted: this is a personal tool and the repo is the source of truth.
3. **A resident process with `bypassPermissions`** has a wider window than one
   launched deliberately. Accepted explicitly; recorded here so the choice is
   visible rather than inherited.
