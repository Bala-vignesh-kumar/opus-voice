# Build report — 18 August 2026, overnight run

Three things were asked for: an install anyone can run without doing anything, a
window instead of a terminal, and something that sounds like a person. All three
are built, tested, committed and pushed. What follows is what was actually
verified, and what was not.

Three commits on `main`, pushed to
[github.com/Bala-vignesh-kumar/opus-voice](https://github.com/Bala-vignesh-kumar/opus-voice).

---

## What you have to do when you wake up

**1. Turn on Dictation.** System Settings › Keyboard › Dictation → On. Wait for
the language download to finish. Apple's recognizer will not start at all without
it — this is why "Nakshatra residency" came back as "Notice Dhaval". It has never
been enabled on this Mac, so every session so far has been going over the network
with the generic model.

**2. Revoke the GitHub token.** The push tonight succeeded, which means the token
you pasted still works. github.com/settings/tokens.

Then:

```sh
npm run app
```

That's it. Say "falcon".

---

## 1. One-command install

`install.sh` at the repo root. Checks macOS and the Swift toolchain, installs Node
via Homebrew if it is missing, runs `npm install`, builds both Swift binaries,
downloads the neural voice, creates `config.json`, installs the `claude` CLI, and
prints a ✓/✗ line for every component.

It verifies rather than assumes. The voice check synthesizes an actual test
phrase, because a truncated download leaves a file that exists and does not work.

**Verified by running it**, twice, on a clean copy of the repo with no `vendor/`,
`bin/` or `node_modules/`:

- First run, from nothing: every component green, 63MB voice downloaded and
  synthesis confirmed, `config.json` created.
- Second run: skipped the download, kept an edited `config.json` untouched. It is
  safe to re-run.

Two bugs it found, both now fixed:

- **`bin/` did not exist in a fresh clone.** Git does not track empty directories,
  so the Swift link step failed with `ld: open() failed ... for 'bin/voiceio'`.
  This would have hit every single person who cloned the repo. `build.sh` now
  creates it.
- **The Claude auth check always failed.** It used `timeout`, which does not exist
  on macOS, so the command errored instantly and every install reported "not
  signed in". Now capped with `perl -e 'alarm'`, and correctly reports signed in.

One thing worth knowing: **espeak-ng holds its data path in a fixed 160-character
buffer.** Install this somewhere deep enough to overflow that and Piper silently
falls back to a path from the machine that built the wheel, and every synthesis
fails — you get the robotic system voice with no explanation. I hit this in a
scratch directory and spent a while proving it: identical package versions,
identical files, works at a short path, fails at a long one. `install.sh` now
warns if the install path is over 90 characters. Keep it at `~/opus-voice`.

## 2. The window

`npm run app`. A real Mac window: the conversation as it happens, the interim
transcript while you are still talking, the current mode, tool calls as they run,
buttons for discuss / take notes / sleep, and a text box. Escape interrupts it
mid-sentence. The orb at the bottom is still when asleep, breathing while
listening, pulsing while it talks.

**WKWebView, not Electron.** A few hundred kilobytes of AppKit that already ships
with macOS, so the one-command install does not have to download a browser
runtime. **Server-sent events, not WebSockets** — the traffic is almost entirely
one direction, SSE is built into both Node and the browser, and the project keeps
a zero-dependency install.

The conversation logic is not duplicated. Commands from the window land in the
same `handleUtterance` the microphone feeds, and both surfaces render through
`src/view.mjs`, so the terminal and the window cannot disagree. Audio never goes
near the window — echo cancellation only works while capture and playback share
one engine.

The server binds to loopback and requires a token generated at startup. This
process can edit files and run shell commands, and any page you have open could
POST to `127.0.0.1`; the token is what stops it. That is covered by a test.

**Verified**: the window binary launches, loads `/`, `/style.css`, `/app.js` and
opens the event stream (checked by counting what the server actually served). A
command posted to the API went through the orchestrator, woke it, reached Claude,
and came back spoken — the full round trip. Closing the window ends the session.

## 3. Talking like a person

The persona is in the system prompt in `src/style.mjs`, rewritten around what
actually separates a colleague from a service: react before answering when it is
honest to, carry the thread instead of restating context, ask one short question
rather than guessing at length, never narrate the process, stop where a person
would stop.

The one thing that cannot come from the model is the beat before it has produced a
word. Those now match what you asked: "sure" or "on it" for an instruction, "mm,
let me think" for a question. Saying "let me think about that" in reply to "open
the config file" sounds like it misheard you. Nothing is said twice in a row.

---

## What is shaky, or not done

- **I could not test it by voice.** Dictation is off on this machine, so every
  test went through typed input and the window API. The speech path — wake word,
  endpointing, barge-in — is unchanged from what you have been using, but the new
  filler timing has never been heard out loud. Expect to want a tweak or two once
  you actually talk to it.
- **The window has not been looked at by human eyes.** I confirmed it opens and
  loads every asset, not that the design reads well at a glance. Tell me what to
  change.
- **`curl | bash` was not exercised.** The local `./install.sh` path was run twice
  end to end; the branch that clones the repo first was not, since this machine
  already has the repo. It is the smaller half of the script, but it is untested.
- **Persona quality is one data point.** Verified it answers and the shape is
  right, not that it holds up over a long conversation.
- **Speaker identity is still not built.** Voice lock for chat mode, speaker
  labels in notes — this is the question from earlier that you have not answered,
  and it is a real dependency decision (a ~100MB ONNX model I have not yet
  confirmed is available and correct, versus ~2GB of PyTorch). Still waiting on
  your call: voice lock only, both, or check the model situation first.
- **No license file.** The repo is public with no license, which means nobody can
  legally reuse it. MIT if you want them to.

## Tests

43 passing, `npm test`. New coverage: the conversation state the window renders
from (bounded history, answers joining one entry, interim text never entering the
transcript), how the thinking beat is chosen, and the window server — including
that a command without the right token is refused.

Two fixes came out of writing them. Replying to an unauthorized POST without
draining its body leaves unread bytes in the socket, which surfaces as the *next*
request on that connection being reset. And Piper is supposed to exit during
shutdown, so warning about it put an alarming red line under an ordinary ctrl-c.
