# Falcon — working notes for whoever picks this up

A macOS voice assistant. You talk, Claude Code answers out loud, in the project
you point it at. `README.md` is for the person using it. This file is for
whoever is changing it, and it exists because several hard-won facts about this
machine are invisible in the code and expensive to rediscover.

**Read `docs/DECISIONS.md` before changing anything to do with audio,
recognition or the headphone gesture.** It carries the measurements. This file
carries the rules.

---

## The shape of it

Five processes. Knowing which one owns what saves an hour:

```
Falcon.app (bin/falcon)                     dock icon, menus, window, squeeze
  └── node src/index.mjs                    the orchestrator — all the policy
        ├── bin/voiceio (Swift)             microphone, recognizer, playback
        ├── claude (the CLI)                one long-lived streaming session
        ├── scripts/piper_server.py         text to speech
        ├── scripts/whisper_server.py       second-opinion transcription
        └── cloudflared                     only while a call is running

bin/falcon-window                           the window alone, for `npm run app`
```

The app is six small files rather than one large one. `FalconApp.swift`
coordinates and supervises; `StatusItem.swift` is the menu bar item,
`MainMenu.swift` the menu along the top, `FalconWindow.swift` the window (built
into *both* binaries, so there is one of it), `SessionClient.swift` the event
stream and command POSTs, `AppLaunch.swift` the launch decisions that are pure
enough to test.

Closing the window hides it; the session keeps listening. Quit is cmd-Q. A
headphone squeeze wakes the session *and* summons the window; the Siri Shortcut
wakes it and summons nothing, because you say that phrase when you are not at
the screen.

`src/index.mjs` is the only place that decides anything. Everything else is a
device driver. If you are adding behaviour, it almost certainly belongs there.

Calling follows that split too: `src/phone.mjs` is the provider driver,
`src/tunnel.mjs` the cloudflared driver, and `src/call.mjs` holds only which
state a call is in and what an event implies — mechanism, on the same line
`chunk.mjs` sits on. Whether to call, what to say, and what your answer means
are all in `index.mjs`. `docs/superpowers/specs/2026-09-12-outbound-calling-design.md`
has the reasoning; hard rule 1 has the parts you may not quietly change.

The window is a `WKWebView` pointed at a loopback server in node (`src/server.mjs`),
authorised by a token in the URL that is **regenerated every time node starts**.

---

## Hard rules

These are settled decisions, most of them paid for in a long debugging session.
Changing one is a real decision, not a tidy-up — say so out loud first.

1. **Two paths leave the machine, both opt-in, both announced.** Everything
   else stays local — Whisper and Piper are on this box for that reason, and
   the microphone's audio still goes nowhere on any ordinary turn.

   The transcript leaves since the owner made `--backend gateway`
   (`src/gateway.mjs`) the default: it sends what you said to a hosted model.
   That was an explicit decision, made out loud, overriding what this rule used
   to say.

   **Calls leave too, and they are the worse of the two.** `"phone": true`
   (`src/phone.mjs`) lets Falcon dial a real telephone. A call necessarily
   carries audio off the machine in both directions — including the voice of
   whoever picks up, who never agreed to anything and is not a user of this
   app. That asymmetry is the reason for the rules below, and it is not a
   detail to optimise away.

   Each of those paths keeps the same three guarantees, and so does the next
   one anybody adds: it refuses to start without its key in the environment
   (`EXPLABS_API_KEY`, `RETELL_API_KEY`), reads no key from `config.json`, and
   announces itself out loud at startup. Keep those three.

   Calling carries three more, all of them tested:

   - **It says what it is.** Every call opens by naming itself an AI assistant
     and who it is calling for. `DISCLOSURE` in `src/phone.mjs`, asserted in
     `test/phone.test.mjs` and again over the wire in `test/booking.test.mjs`.
     Not configurable. Somebody picked up a phone expecting a person.
   - **It commits to nothing on its own.** The agent's only route to a booking,
     a cancellation or a promise is `ask_my_boss`, which holds the line and
     asks you. If you do not answer within `phoneHoldMs`, it promises a call
     back and hangs up — it never guesses on your behalf. See
     `CALL_BACK_INSTRUCTION` in `src/call.mjs`.
   - **The public door is only open during a call.** `src/tunnel.mjs` runs a
     cloudflared quick tunnel for the length of one call, and `/consult` 404s
     whenever no call is in flight, so a leaked URL is inert. The route needs
     the session token, the per-call secret and a matching call id.

   It does not record calls. Do not add that quietly.

2. **`permissionMode` stays `bypassPermissions`.** Asked and answered by the
   owner. Do not "harden" it.

3. **`config.json` is untracked and personal.** It is the running config on
   somebody's actual machine. Change it only when asked, change one thing at a
   time, and say what you changed and how to put it back.

4. **Never write to a child process's stdin without guarding it.** Check
   `exitCode`/`signalCode`, wrap the write, and put an `error` listener on the
   pipe. An unlistened pipe throws at the process, and this app has died that
   way twice — once from inside `shutdown()`, which is the one place it must
   not, because that is what restores the microphone.

5. **A dead child restarts; it does not end the app.** The Claude session, the
   audio daemon and the window all recover. Losing a microphone is not a reason
   to stop being an assistant. Keep the give-up policy (three deaths in a
   minute) so a genuinely broken device does not respawn forever.

6. **Never judge a recognizer against a buffer you have not looked at.** The
   single most expensive mistake made here: hours spent comparing Whisper and
   Apple, concluding Whisper was worse, when the buffers being fed to it were
   30 seconds of room noise. Dump the audio, check its length and where the
   energy is, and only then compare.

---

## Verifying a change

`npm test` — 142 node tests plus the Swift suites. Both must pass.

The tests do not touch hardware: `test/stubs/` stands in for the Claude CLI,
voiceio, Piper and Whisper, injected through constructor options
(`bin`/`server`/`python`) or `FALCON_*_BIN`. Follow that pattern rather
than reaching for real devices.

**Tests passing is not evidence the app works.** Almost every fault found in
this project was invisible to the suite — a PATH difference, a permission, a
Bluetooth state. Drive the running app as well:

```bash
# the live session's token
K=$(python3 -c "import json;print(json.load(open('$HOME/.falcon/session.json'))['url'].split('k=')[1])")

curl -s -X POST "http://127.0.0.1:4477/command?k=$K" \
     -H 'content-type: application/json' -d '{"cmd":"mode","mode":"chat"}'
curl -s -X POST "http://127.0.0.1:4477/command?k=$K" \
     -H 'content-type: application/json' -d '{"cmd":"say","text":"Say the word ready."}'
curl -sN --max-time 25 "http://127.0.0.1:4477/events?k=$K"   # watch it happen
```

A typed turn exercises everything except the microphone. Expect
`you` → `thinking` → `falcon` → `speaking:true` → `speaking:false` in about 1.5s.

To see the window's own state without a browser extension, drive headless
Chromium over CDP — Edge is installed. Use a **fresh tab per run**: a reused tab
leaves the previous page's `EventSource` retrying with a dead token, and its
403s land in your evidence.

---

## When the headphone squeeze stops working

This one has been diagnosed from scratch five times. Read this before doing it
a sixth.

**The bud has to be in A2DP.** In SCO — the narrowband hands-free call mode — a
stem pinch means "end call", not play/pause, so no AVRCP command is emitted at
all. Nothing reaches macOS and nothing can reach this app. The squeeze does not
fail; it never happens, and every log on our side stays silent, which reads
exactly like the app being broken.

**A second way to break it, with identical symptoms:** replacing
`/Applications/Falcon.app` while it is running. macOS routes AVRCP commands by
bundle identity, so `rm -rf` on the bundle of a live process leaves it running
with no identity to route to — armed, listening, and unreachable. `bundle.sh`
now quits a running copy first rather than clobbering it.

**What puts it in SCO:** any duplex audio path — an audio unit that takes the
microphone as well as the speaker. `setVoiceProcessingEnabled(true)`, i.e.
`"echoCancellation": true`, is one. An `AVAudioEngine`-based keepalive is
another, which is why `Keepalive.swift` is a plain `AVAudioPlayer`. Both are now
guarded: see `EchoPolicy.swift`, which refuses the combination outright.

**How to tell in ten seconds**, without touching the code:

```bash
log show --last 1m --predicate 'eventMessage CONTAINS "HFP LinkQualityReport"' | wc -l
```

A steady stream of those (roughly one a second) means SCO is up and the squeeze
cannot work. Zero means A2DP and it should. `AStS SCO` versus `AStS A2DP` in the
Bluetooth device dump says the same thing.

**Then work outward in this order** — each step has its own evidence, so you
never have to guess which half is broken:

| Question | Where the answer is |
|---|---|
| Did the bud emit anything? | `HFP LinkQualityReport` / `AStS` above |
| Did the app receive it? | `headphone command:` in the app log — logged for *every* command, bound or not |
| Did the app act? | `woke by headphone squeeze` |
| Did the file get poked? | `~/.falcon/wake` mtime |
| Did node react? | `woken from outside` in the log |
| Did the mode change? | `mode` on the `/events` stream |

Also worth knowing: a squeeze wakes **silently** by default (`wakeAck` is empty)
and lands in `awake`, which sleeps again after `awakeTimeoutMs`. Clicking
Discuss says "sure, let's talk." out loud and lands in `chat`, which never
sleeps. So a working squeeze and a broken one can feel identical if you are not
looking at the screen.

## Where to look when it breaks

| | |
|---|---|
| App log | `~/.falcon/falcon.log` — **truncated on every node start** |
| Session URL + token | `~/.falcon/session.json` |
| Audio dumps | set `"dumpAudio": "/tmp/dump"`, then `/tmp/dump-N.wav` |
| Bluetooth / AirPods | `/usr/bin/log show --last 5m --predicate 'eventMessage CONTAINS "PrNm AirPods"'` |
| Every recognizer result | set `"trace": true` |

Two traps that have each cost an hour:

- **The log is truncated per launch.** If node is restarting, the reason for the
  last death is already gone. Capture continuously, or run
  `node src/index.mjs --ui --spawn-window false --dir . --uiPort 4488` in the
  foreground where you can see it die. That second instance will steal the
  microphone from the real app and make *it* crash-loop, so kill it after.
- **`log` is shadowed by a shell function here.** Use `/usr/bin/log`.

And do not analyse a file a background `curl` is still writing to. That produced
one confident, entirely wrong conclusion about the event stream.

---

## Style

Look at `git log` before writing a commit message. They are sentences about
behaviour — "Stop the trim throwing away the words it was meant to keep" — not
`fix(audio):` prefixes. Comments explain *why*, especially where the code looks
odd because a device forced it to be. Match that; this codebase is written to
be read.
