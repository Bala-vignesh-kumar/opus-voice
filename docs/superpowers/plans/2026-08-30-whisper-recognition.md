# Local Whisper Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send Claude a locally-run Whisper transcription instead of Apple's, without disturbing the live recognition that drives the interface.

**Architecture:** Hybrid. Apple's `SpeechTranscriber` keeps producing partials for the interim line, word-based barge-in and endpointing. In parallel, the microphone tap fills a per-turn audio buffer; on endpoint that audio goes to a local Whisper process and *its* text becomes the turn. Every Whisper failure falls back to Apple's text.

**Tech Stack:** Swift 6 / AVFoundation, Node 18+ ESM with `node --test`, Python 3.9 in the existing `vendor/py` venv, `faster-whisper` (candidate — Task 1 decides).

**Spec:** `docs/superpowers/specs/2026-08-30-whisper-recognition-design.md`

## Global Constraints

- **Fully local.** No API key, no network at inference time, no audio leaving the machine. This is a README promise.
- **Zero npm dependencies.** Node code uses only `node:` built-ins.
- **No XCTest, no SPM, no Xcode project.** Swift is compiled by `swiftc` from `build.sh`; Swift tests run through `scripts/test-swift.sh`.
- **Swift files carrying top-level code must use `@main`** — only `main.swift` may have statements at file scope, and every Swift file here is compiled alongside others.
- **A turn is never lost.** Any Whisper failure falls back to Apple's text.
- **The terminal workflow keeps working.** `npm start` and `npm run app` behave identically after every task.
- **Comment style:** explain *why*, not *what*.
- **Commit style:** imperative subject naming the actual problem, prose body, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.
- **Python is 3.9.6** in `vendor/py`. Anything installed must support it.

## Parallelism

Tasks 1–4 touch **disjoint files** and can run concurrently. Task 5 needs all of them. Task 6 needs Task 1.

| task | owns these files | depends on |
|---|---|---|
| 1 | `scripts/measure-whisper.sh`, the spec's results section | — |
| 2 | `swift/UtteranceBuffer*.swift`, `swift/VoiceIO.swift`, `build.sh`, `scripts/test-swift.sh`, `swift/TestMain.swift` | — |
| 3 | `src/whisper.mjs`, `test/whisper.test.mjs`, `test/stubs/whisper_server.mjs` | — |
| 4 | `src/transcript-guard.mjs`, `test/transcript-guard.test.mjs` | — |
| 5 | `src/index.mjs`, `src/config.mjs`, `src/voice.mjs`, `test/e2e.test.mjs` | 1,2,3,4 |
| 6 | `scripts/install-whisper.sh`, `scripts/whisper_server.py`, `README.md` | 1 |

---

### Task 1: Measure before choosing an engine

The spec refuses to pick an engine by argument. This task produces the numbers.

**Files:**
- Create: `scripts/measure-whisper.sh` (kept — it is how the choice gets re-checked later)
- Modify: `docs/superpowers/specs/2026-08-30-whisper-recognition-design.md` (record results)

**Interfaces:**
- Consumes: nothing
- Produces: a chosen `whisperModel` value and engine, recorded in the spec. Task 6 installs what this picks.

- [ ] **Step 1: Install faster-whisper into the existing venv**

```bash
cd "$(git rev-parse --show-toplevel)"
./vendor/py/bin/pip install -q faster-whisper 2>&1 | tail -3
./vendor/py/bin/python -c "import faster_whisper; print('faster-whisper ok')"
```

If the install fails on Python 3.9, record the exact error in the spec and report it — that alone eliminates the Python route and makes `whisper.cpp` the answer.

- [ ] **Step 2: Write the measurement script**

```bash
cat > scripts/measure-whisper.sh <<'SH'
#!/bin/bash
# Times local Whisper transcription, so the model choice has evidence behind it.
#
# Speed only. Accuracy needs a human reading the output against what they
# actually said, which is the point of printing the transcript rather than
# scoring it here.
set -euo pipefail
cd "$(dirname "$0")/.."

WAV="${1:-}"
[ -n "$WAV" ] && [ -f "$WAV" ] || { echo "usage: measure-whisper.sh SAMPLE.wav"; exit 1; }

for model in tiny base small medium; do
  ./vendor/py/bin/python - "$WAV" "$model" <<'PY'
import sys, time
from faster_whisper import WhisperModel
wav, name = sys.argv[1], sys.argv[2]
t0 = time.time()
model = WhisperModel(name, device="cpu", compute_type="int8")
load = time.time() - t0
t1 = time.time()
segments, _ = model.transcribe(wav, language="en")
text = " ".join(s.text for s in segments).strip()
run = time.time() - t1
print(f"{name:8} load={load:5.1f}s  transcribe={run:5.2f}s  {text!r}")
PY
done
SH
chmod +x scripts/measure-whisper.sh
```

- [ ] **Step 3: Record a sample of real speech**

```bash
# 6 seconds of the user's own voice, which is the only accent that matters here.
./vendor/py/bin/python -c "
import sounddevice" 2>/dev/null || echo "(no sounddevice; use the fallback below)"
```

Fallback that needs no extra package — record with the system tool:

```bash
/usr/bin/afrecord -f WAVE -d 6 /tmp/sample.wav 2>/dev/null \
  || sox -d -r 16000 -c 1 /tmp/sample.wav trim 0 6 2>/dev/null \
  || echo "ASK THE USER to record 6 seconds and save it to /tmp/sample.wav"
```

If no recorder is available, **stop and ask the user** to speak a sentence and save it. Do not substitute synthetic speech: the whole question is how these models handle this speaker's accent, and a synthesised voice answers a different question.

- [ ] **Step 4: Run the measurement**

Run: `./scripts/measure-whisper.sh /tmp/sample.wav`

Expected: four lines, each with a load time, a transcribe time, and the text.

- [ ] **Step 5: Record the result in the spec**

Replace the `whisperModel` row's note and add a **Measured** section to
`docs/superpowers/specs/2026-08-30-whisper-recognition-design.md`, giving the
real table and one sentence naming the choice, e.g.:

> **Measured 2026-08-30**, on a 6.0s sample of the user's speech:
>
> | model | load | transcribe | transcript |
> |---|---|---|---|
> | tiny | 0.4s | 0.31s | "what files are in this project" |
> | base | 0.6s | 0.52s | "what files are in this project" |
> | small | 1.9s | 1.44s | "what files are in this project" |
>
> `base` chosen: it matched `small` on this sample at a third of the cost.
> Load time is paid once at startup, so only the transcribe column is felt.

If every model transcribes in over a second, say so plainly and recommend
either `whisper.cpp` or abandoning the change — the spec's Risk 1 anticipates
this and it is an acceptable outcome.

- [ ] **Step 6: Commit**

```bash
git add scripts/measure-whisper.sh docs/superpowers/specs/2026-08-30-whisper-recognition-design.md
git commit -m "Measure local Whisper before choosing a model

The spec refuses to pick an engine by argument, so this is the evidence.
Speed is measured here; accuracy is the printed transcript read against
what was actually said, because scoring it automatically would need a
reference the speaker has not written down.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Buffer the audio of one utterance

**Files:**
- Create: `swift/UtteranceBuffer.swift`, `swift/UtteranceBufferTests.swift`
- Modify: `swift/VoiceIO.swift`, `swift/TestMain.swift`, `scripts/test-swift.sh`, `build.sh`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `final class UtteranceBuffer` with `append(_ samples: [Float])`, `func take() -> [Float]`, `func reset()`, `var seconds: Double`, `var peak: Float`
  - `init(sampleRate: Double = 16000, maxSeconds: Double = 30)`
  - A `voiceio` stdout event `{"type":"utterance","pcm":"<base64 float32le>","sampleRate":16000,"peak":0.31}` emitted immediately before the existing `final` event.

  Task 5 consumes that event.

- [ ] **Step 1: Write the failing tests**

```swift
// swift/UtteranceBufferTests.swift
import Foundation

func runUtteranceBufferTests() -> Int {
  var failures = 0
  func check(_ c: Bool, _ what: String) { if !c { print("  ✗ \(what)"); failures += 1 } }

  let b = UtteranceBuffer(sampleRate: 16000, maxSeconds: 1.0)
  check(b.take().isEmpty, "a fresh buffer holds nothing")

  b.append([0.1, 0.2, 0.3])
  check(b.take().count == 3, "appended samples come back")

  // take() is destructive: a turn's audio belongs to that turn only.
  check(b.take().isEmpty, "taking empties it")

  // The cap exists so a forgotten open microphone cannot grow without limit.
  let over = [Float](repeating: 0.5, count: 16000 * 2)   // 2s into a 1s cap
  b.append(over)
  check(b.seconds <= 1.0 + 0.001, "the buffer is capped at maxSeconds")
  check(b.take().count == 16000, "the cap keeps exactly maxSeconds of samples")

  // Capping keeps the END, not the start: the most recent second of speech is
  // the part somebody actually said, and dropping it would truncate the turn.
  let c = UtteranceBuffer(sampleRate: 4, maxSeconds: 1.0)
  c.append([1, 2, 3, 4, 5, 6])
  check(c.take() == [3, 4, 5, 6], "the cap drops the oldest samples")

  // peak drives the energy floor that keeps Whisper from hallucinating on
  // silence, so it has to survive until the audio is taken.
  let d = UtteranceBuffer(sampleRate: 16000, maxSeconds: 30)
  d.append([0.0, -0.4, 0.2])
  check(abs(d.peak - 0.4) < 0.0001, "peak is the largest magnitude seen")
  _ = d.take()
  check(d.peak == 0, "peak resets with the buffer")

  if failures == 0 { print("  ✓ utterance buffer") }
  return failures
}
```

Wire it in:

```bash
python3 - <<'PY'
p='swift/TestMain.swift'; s=open(p).read()
s=s.replace("+ runTurnAssemblerTests()","+ runTurnAssemblerTests() + runUtteranceBufferTests()",1)
open(p,'w').write(s)
p='scripts/test-swift.sh'; s=open(p).read()
s=s.replace("  swift/TurnAssembler.swift swift/TurnAssemblerTests.swift \\",
            "  swift/TurnAssembler.swift swift/TurnAssemblerTests.swift \\\n  swift/UtteranceBuffer.swift swift/UtteranceBufferTests.swift \\",1)
open(p,'w').write(s)
PY
```

- [ ] **Step 2: Run to verify it fails**

Run: `./scripts/test-swift.sh`
Expected: FAIL — `cannot find 'UtteranceBuffer' in scope`

- [ ] **Step 3: Implement**

```swift
// swift/UtteranceBuffer.swift
// The audio of one spoken turn, kept so a better recognizer can have a second
// look at it.
//
// Apple's recognizer drives the interface — partials, barge-in, endpointing —
// and is good enough for all three. It is the text reaching Claude that suffers
// on an accent it was not tuned for, so that text, and only that text, is
// re-derived from this audio.
//
// A class rather than a struct: the microphone tap appends to it from an audio
// thread thousands of times a second, and copying an array that large per
// buffer is exactly the allocation churn a realtime callback must not do.

import Foundation

final class UtteranceBuffer {
  private let lock = NSLock()
  private var samples: [Float] = []
  private let maxSamples: Int
  private(set) var peak: Float = 0

  let sampleRate: Double

  init(sampleRate: Double = 16000, maxSeconds: Double = 30) {
    self.sampleRate = sampleRate
    self.maxSamples = Int(sampleRate * maxSeconds)
  }

  var seconds: Double {
    lock.lock(); defer { lock.unlock() }
    return Double(samples.count) / sampleRate
  }

  func append(_ incoming: [Float]) {
    lock.lock(); defer { lock.unlock() }
    samples.append(contentsOf: incoming)
    for value in incoming {
      let magnitude = abs(value)
      if magnitude > peak { peak = magnitude }
    }
    // Keep the end, not the start. The most recent audio is what was just said;
    // dropping it would truncate the turn rather than the silence before it.
    if samples.count > maxSamples {
      samples.removeFirst(samples.count - maxSamples)
    }
  }

  /// The turn's audio. Destructive: this audio belongs to one turn only, and
  /// leaving it behind would prepend the last turn to the next one.
  func take() -> [Float] {
    lock.lock(); defer { lock.unlock() }
    let out = samples
    samples = []
    peak = 0
    return out
  }

  func reset() {
    lock.lock(); defer { lock.unlock() }
    samples = []
    peak = 0
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `./scripts/test-swift.sh`
Expected: `✓ utterance buffer`

- [ ] **Step 5: Feed it from the microphone tap**

In `swift/VoiceIO.swift`, add the property beside `turn`:

```swift
    /// The audio behind the current turn, for the second-opinion recognizer.
    private let utterance = UtteranceBuffer()
```

In `startInput()`'s tap closure, after `self.meter(mono)`:

```swift
            self.utterance.append(self.samples16k(from: mono))
```

Add the resampler beside `mono(from:)`:

```swift
    /// Whisper wants 16kHz mono float32. The microphone is usually 48kHz, so
    /// this decimates rather than dragging in a converter for a 3x integer
    /// ratio — the recognizer is not sensitive to the difference and an audio
    /// thread should not be allocating an AVAudioConverter per buffer.
    private func samples16k(from buffer: AVAudioPCMBuffer) -> [Float] {
        guard let channel = buffer.floatChannelData?[0] else { return [] }
        let stride = max(1, Int((buffer.format.sampleRate / 16000).rounded()))
        var out: [Float] = []
        out.reserveCapacity(Int(buffer.frameLength) / stride + 1)
        var i = 0
        while i < Int(buffer.frameLength) {
            out.append(channel[i])
            i += stride
        }
        return out
    }
```

- [ ] **Step 6: Emit the audio with the turn**

In `startEndpointTimer()`, immediately before `emit(["type": "final", "text": text])`:

```swift
            // Emitted before the final so the orchestrator has the audio in
            // hand when the turn arrives, and never has to hold a turn open
            // waiting for it.
            let audio = self.utterance.take()
            if !audio.isEmpty {
                let bytes = audio.withUnsafeBufferPointer { Data(buffer: $0) }
                emit([
                    "type": "utterance",
                    "pcm": bytes.base64EncodedString(),
                    "sampleRate": 16000,
                    "peak": self.utterance.peak,
                ])
            }
```

**Careful:** read `peak` *before* `take()` resets it. Capture it first:

```swift
            let peak = self.utterance.peak
            let audio = self.utterance.take()
```

and use `peak` in the emitted dictionary.

Also reset the buffer whenever the turn is abandoned, in `setStandby(_:)` where
standby is entered, beside `state.sync { partial = "" }`:

```swift
            utterance.reset()
```

- [ ] **Step 7: Add to the build and verify**

```bash
python3 -c "
p='build.sh'; s=open(p).read()
s=s.replace('  swift/TurnAssembler.swift \\\\','  swift/TurnAssembler.swift \\\\\n  swift/UtteranceBuffer.swift \\\\',1)
open(p,'w').write(s)"
./build.sh 2>&1 | grep -E '^built|error:'
./scripts/test-swift.sh
```

Expected: all three binaries build, all Swift suites pass.

- [ ] **Step 8: Commit**

```bash
git add swift/UtteranceBuffer.swift swift/UtteranceBufferTests.swift swift/VoiceIO.swift swift/TestMain.swift scripts/test-swift.sh build.sh
git commit -m "Keep the audio of a turn so a better recognizer can hear it

Apple's recognizer drives the interface and is good enough for partials,
barge-in and endpointing. It is the text reaching Claude that suffers on
an accent it was not tuned for, so the audio behind each turn is kept and
that text alone will be re-derived from it.

Capped at 30 seconds, keeping the end rather than the start: the recent
audio is what was just said, and dropping it would truncate the turn
instead of the silence in front of it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The Whisper supervisor

**Files:**
- Create: `src/whisper.mjs`, `test/whisper.test.mjs`, `test/stubs/whisper_server.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export class Whisper extends EventEmitter` — `new Whisper({ model, timeoutMs })`
  - `async transcribe(float32Base64, sampleRate) → Promise<string>` — resolves `''` on any failure
  - `available() → boolean` — no arguments; checks the venv and server script exist
  - `close()`
  - Emits `'warn'`, `'exit'`

  Task 5 constructs it and calls `transcribe`.

- [ ] **Step 1: Write the stub server**

```javascript
// test/stubs/whisper_server.mjs
// Stands in for scripts/whisper_server.py. Behaviour is chosen by env var so
// one stub covers every path the supervisor has to survive.
import readline from 'node:readline';

const mode = process.env.STUB_WHISPER_MODE || 'ok';
if (mode === 'crash') process.exit(3);

process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.cmd === 'quit') process.exit(0);
  if (mode === 'hang') return;                       // never answers
  if (mode === 'error') {
    process.stdout.write(`${JSON.stringify({ type: 'error', id: message.id, message: 'model exploded' })}\n`);
    return;
  }
  if (mode === 'empty') {
    process.stdout.write(`${JSON.stringify({ type: 'text', id: message.id, text: '' })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ type: 'text', id: message.id, text: 'what files are in this project' })}\n`);
});
```

- [ ] **Step 2: Write the failing tests**

```javascript
// test/whisper.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Whisper } from '../src/whisper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = path.join(ROOT, 'test', 'stubs', 'whisper_server.mjs');

/** Base64 of a few float32 samples; contents do not matter to the stub. */
const PCM = Buffer.from(new Float32Array([0.1, -0.2, 0.3]).buffer).toString('base64');

function open(mode = 'ok', options = {}) {
  return new Whisper({ bin: process.execPath, server: STUB, env: { STUB_WHISPER_MODE: mode }, ...options });
}

test('a transcription comes back', async () => {
  const w = open();
  try {
    assert.equal(await w.transcribe(PCM, 16000), 'what files are in this project');
  } finally { w.close(); }
});

test('an engine error is not an exception', async () => {
  // Losing a turn because the nicer recognizer failed is worse than a less
  // accurate turn, so failure is an empty string and the caller falls back.
  const w = open('error');
  try {
    assert.equal(await w.transcribe(PCM, 16000), '');
  } finally { w.close(); }
});

test('a hang gives up rather than holding the turn open', async () => {
  const w = open('hang', { timeoutMs: 300 });
  try {
    const started = Date.now();
    assert.equal(await w.transcribe(PCM, 16000), '');
    assert.ok(Date.now() - started < 2000, 'timed out promptly');
  } finally { w.close(); }
});

test('empty text is a failure, not an answer', async () => {
  const w = open('empty');
  try {
    assert.equal(await w.transcribe(PCM, 16000), '');
  } finally { w.close(); }
});

test('a dead process does not take the app with it', async () => {
  const w = open('crash');
  const warnings = [];
  w.on('warn', (m) => warnings.push(m));
  try {
    assert.equal(await w.transcribe(PCM, 16000), '');
  } finally { w.close(); }
});

test('two transcriptions in flight do not cross', async () => {
  const w = open();
  try {
    const [a, b] = await Promise.all([w.transcribe(PCM, 16000), w.transcribe(PCM, 16000)]);
    assert.equal(a, 'what files are in this project');
    assert.equal(b, 'what files are in this project');
  } finally { w.close(); }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/whisper.test.mjs`
Expected: FAIL — `Cannot find module '../src/whisper.mjs'`

- [ ] **Step 4: Implement**

```javascript
// src/whisper.mjs
// Local Whisper, as a long-lived subprocess.
//
// Loading the model costs seconds, so it happens once at startup rather than
// per turn — the same reason scripts/piper_server.py stays resident.
//
// Every failure here resolves to an empty string rather than rejecting. The
// caller falls back to Apple's text, because losing a turn to a recognizer
// being unavailable is worse than a turn transcribed less well.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = path.join(ROOT, 'vendor/py/bin/python');
const SERVER = path.join(ROOT, 'scripts/whisper_server.py');

/** Whether local Whisper is installed at all. */
export function available() {
  return fs.existsSync(PYTHON) && fs.existsSync(SERVER);
}

export class Whisper extends EventEmitter {
  constructor({ model = 'base', timeoutMs = 3000, bin = PYTHON, server = SERVER, env = {} } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();     // id -> resolve
    this.nextId = 1;
    this.dead = false;

    this.child = spawn(bin, [server, model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    this.child.on('error', (err) => this.#die(`whisper: ${err.message}`));
    this.child.on('exit', (code) => {
      // Expected on the way out; only worth reporting if it was not asked for.
      if (!this.closing) this.#die(`whisper exited (code ${code})`);
      this.emit('exit', code);
    });
    this.child.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) this.emit('stderr', text);
    });

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') { this.emit('ready'); return; }
      const settle = this.pending.get(message.id);
      if (!settle) return;
      this.pending.delete(message.id);
      // An empty transcription is a failure, not an answer: it would send
      // Claude nothing where Apple had heard something.
      settle(message.type === 'text' ? String(message.text || '').trim() : '');
    });
  }

  /**
   * @param {string} pcm base64 float32 little-endian mono
   * @returns {Promise<string>} the transcription, or '' on any failure
   */
  transcribe(pcm, sampleRate) {
    if (this.dead || !pcm) return Promise.resolve('');
    const id = this.nextId++;
    return new Promise((resolve) => {
      // Resolved exactly once, whichever of answer, timeout or death lands first.
      let done = false;
      const settle = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(text);
      };
      const timer = setTimeout(() => {
        // The turn is already waiting on this. Better a less accurate turn now
        // than a perfect one after the moment has passed.
        this.emit('warn', 'whisper timed out — using the system recognizer for that turn');
        settle('');
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, settle);
      try {
        this.child.stdin.write(`${JSON.stringify({ id, pcm, sampleRate })}\n`);
      } catch {
        settle('');
      }
    });
  }

  #die(message) {
    if (this.dead) return;
    this.dead = true;
    this.emit('warn', `${message} — using the system recognizer from here`);
    for (const settle of this.pending.values()) settle('');
    this.pending.clear();
  }

  close() {
    this.closing = true;
    try { this.child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`); } catch { /* already gone */ }
    this.child.stdin.end();
    this.child.kill();
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/whisper.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add src/whisper.mjs test/whisper.test.mjs test/stubs/whisper_server.mjs
git commit -m "Supervise a local Whisper process, and survive it failing

Loading the model costs seconds, so it stays resident — the same reason
the Piper server does. What this adds is that every failure resolves to
an empty string rather than throwing: a dead process, a hang, an engine
error and an empty transcription all mean the same thing to the caller,
which is 'fall back to the system recognizer for this turn'.

Losing a turn because the better recognizer was unavailable would be
worse than a turn transcribed less well.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Refuse hallucinated turns

**Files:**
- Create: `src/transcript-guard.mjs`, `test/transcript-guard.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `export function isHallucination(text): boolean`, `export const MIN_PEAK`, `export function acceptable(text, peak): boolean`. Task 5 calls `acceptable`.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/transcript-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isHallucination, acceptable, MIN_PEAK } from '../src/transcript-guard.mjs';

test('the stock phrases Whisper invents from silence are refused', () => {
  // These are artefacts of its training data, not things anyone said. In a
  // voice assistant they arrive as unprompted turns from nothing — the same
  // class of bug as a bare "." being answered with "Still here."
  for (const text of [
    'Thank you.', 'thank you', 'Thanks for watching!', 'Thanks for watching.',
    'you', 'You', '.', 'Bye.', 'Subtitles by the Amara.org community',
  ]) {
    assert.equal(isHallucination(text), true, `should refuse: ${text}`);
  }
});

test('the same words inside a real sentence are kept', () => {
  // "thank you" is a thing people say. Only the whole-utterance case is a
  // hallucination.
  for (const text of [
    'thank you for checking that',
    'can you thank the team for me',
    'you were right about the cache',
  ]) {
    assert.equal(isHallucination(text), false, `should keep: ${text}`);
  }
});

test('silence is refused whatever the transcript says', () => {
  // The real defence. A phrase list is never complete; the microphone level is.
  assert.equal(acceptable('what files are in this project', 0.0001), false);
  assert.equal(acceptable('what files are in this project', MIN_PEAK + 0.1), true);
});

test('a real utterance at a real level is accepted', () => {
  assert.equal(acceptable('run the tests again', 0.4), true);
});

test('empty text is never acceptable', () => {
  assert.equal(acceptable('', 0.9), false);
  assert.equal(acceptable('   ', 0.9), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/transcript-guard.test.mjs`
Expected: FAIL — `Cannot find module '../src/transcript-guard.mjs'`

- [ ] **Step 3: Implement**

```javascript
// src/transcript-guard.mjs
// Refusing turns nobody spoke.
//
// Whisper hallucinates on silence and noise. Fed a near-silent buffer it
// confidently returns stock phrases from its training data — "Thank you.",
// "Thanks for watching!", subtitle credits. In a voice assistant those arrive
// as unprompted turns from nothing, which is the same failure as the bare "."
// that once reached Claude and was answered with "Still here."
//
// Two guards, and the order matters: the level check is the real defence,
// because a phrase list is never complete.

/** Below this microphone peak, nothing was said loudly enough to be a turn. */
export const MIN_PEAK = 0.02;

// Whole-utterance only. "thank you" inside a sentence is a person being polite.
const STOCK = new Set([
  'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'you', 'bye', 'goodbye', 'okay', 'so',
  'subtitles by the amara.org community', 'subtitles by the amara org community',
  'transcription by castingwords',
]);

/** Whether the whole transcript is a phrase Whisper invents from silence. */
export function isHallucination(text) {
  const bare = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, '')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!bare) return true;
  // Punctuation on its own is not speech, whatever produced it.
  if (!/[a-z0-9]/.test(bare)) return true;
  return STOCK.has(bare);
}

/**
 * Whether a Whisper transcription should become a turn.
 *
 * @param {string} text  what Whisper returned
 * @param {number} peak  the loudest sample in the utterance, 0..1
 */
export function acceptable(text, peak) {
  if (!String(text).trim()) return false;
  if (Number(peak) < MIN_PEAK) return false;
  return !isHallucination(text);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/transcript-guard.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcript-guard.mjs test/transcript-guard.test.mjs
git commit -m "Refuse turns nobody spoke

Whisper hallucinates on silence. Fed a near-silent buffer it confidently
returns stock phrases out of its training data — thanks-for-watching,
subtitle credits — and in a voice assistant those arrive as unprompted
turns from nothing. It is the same failure as the bare '.' that reached
Claude and got answered with 'Still here.'

The microphone level is the real defence, since a phrase list is never
complete; the list only catches what gets through at a plausible level.
Phrases are matched whole, never inside a sentence, because thanking
somebody is a thing people do out loud.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire Whisper into the turn

**Files:**
- Modify: `src/voice.mjs`, `src/index.mjs`, `src/config.mjs`, `test/e2e.test.mjs`, `test/stubs/voiceio.mjs`

**Interfaces:**
- Consumes: the `utterance` event (Task 2), `Whisper`/`available` (Task 3), `acceptable` (Task 4)
- Produces: nothing further

- [ ] **Step 1: Surface the utterance event**

In `src/voice.mjs`, wherever daemon messages are dispatched to events, add
`utterance` alongside `final` so `voice.on('utterance', …)` works. Follow the
existing switch exactly; if messages are re-emitted generically, no change is
needed — verify by reading the file before editing.

- [ ] **Step 2: Add the config keys**

In `src/config.mjs`, beside `tts`:

```javascript
  stt: 'whisper',           // 'whisper' (local, accurate) or 'apple' (system recognizer)
  whisperModel: 'base',     // set by scripts/measure-whisper.sh
  whisperTimeoutMs: 3000,   // after this, the system recognizer's text is used
```

- [ ] **Step 3: Write the failing end-to-end test**

Append to `test/e2e.test.mjs`:

```javascript
test('a whisper transcription replaces the system recognizer text', async () => {
  const app = new App({ args: ['--stt', 'whisper'], whisperMode: 'ok' });
  try {
    app.speak('what fights are in this project');   // what Apple mis-heard
    await app.expect('what files are in this project');
    const asked = app.asked();
    assert.ok(asked.some((t) => t.includes('what files are in this project')),
      'Claude was asked the whisper text');
  } finally { app.stop(); }
});

test('a whisper failure falls back to the system recognizer', async () => {
  // A turn is never lost because the better recognizer was unavailable.
  const app = new App({ args: ['--stt', 'whisper'], whisperMode: 'error' });
  try {
    app.speak('what fights are in this project');
    await app.expect('what fights are in this project');
  } finally { app.stop(); }
});
```

The `App` harness needs to pass `STUB_WHISPER_MODE` and point `whisper.mjs` at
the stub. Add to its constructor's `env`:

```javascript
        ...(this.whisperMode ? { STUB_WHISPER_MODE: this.whisperMode,
                                 OPUS_VOICE_WHISPER_BIN: process.execPath,
                                 OPUS_VOICE_WHISPER_SERVER: path.join(STUBS, 'whisper_server.mjs') } : {}),
```

and store `this.whisperMode = whisperMode` from the options object.

The stub `voiceio` must emit an `utterance` event before each `final`. In
`test/stubs/voiceio.mjs`, wherever it emits `final`, emit first:

```javascript
  send({ type: 'utterance', pcm: Buffer.from(new Float32Array([0.5, -0.5]).buffer).toString('base64'), sampleRate: 16000, peak: 0.5 });
```

- [ ] **Step 4: Run to verify it fails**

Run: `node --test test/e2e.test.mjs`
Expected: FAIL — the whisper text never arrives; Claude is asked the Apple text.

- [ ] **Step 5: Implement in `src/index.mjs`**

Add the imports beside the others:

```javascript
import { Whisper, available as whisperAvailable } from './whisper.mjs';
import { acceptable } from './transcript-guard.mjs';
```

Construct it beside `speaker`, honouring the env overrides the tests use:

```javascript
// Local Whisper supplies the text that reaches Claude; Apple's recognizer keeps
// driving partials, barge-in and endpointing. If it is not installed we simply
// use Apple's text, which is what happened before this existed.
let whisper = null;
if (config.stt === 'whisper') {
  if (whisperAvailable() || process.env.OPUS_VOICE_WHISPER_SERVER) {
    whisper = new Whisper({
      model: config.whisperModel,
      timeoutMs: config.whisperTimeoutMs,
      bin: process.env.OPUS_VOICE_WHISPER_BIN,
      server: process.env.OPUS_VOICE_WHISPER_SERVER,
    });
    whisper.on('warn', (message) => view.warn(message));
  } else {
    view.warn('whisper is not installed — run npm run install-whisper');
  }
}
```

**Note:** `new Whisper({ bin: undefined })` must fall back to the default —
the destructuring default in Task 3 handles `undefined` correctly.

Hold the last utterance's audio, and make `final` await the transcription:

```javascript
let lastUtterance = null;
voice.on('utterance', (event) => { lastUtterance = event; });

voice.on('final', async (text) => {
  view.clearLive();
  let heard = text;
  const audio = lastUtterance;
  lastUtterance = null;

  if (whisper && audio?.pcm) {
    const better = await whisper.transcribe(audio.pcm, audio.sampleRate);
    // Only take Whisper's word for it when it is plausibly something spoken.
    if (better && acceptable(better, audio.peak)) heard = better;
  }
  handleUtterance(heard);
});
```

Close it in `shutdown()`, beside `speaker.close()`:

```javascript
  whisper?.close();
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all node and Swift suites pass, including the two new end-to-end tests.

- [ ] **Step 7: Commit**

```bash
git add src/index.mjs src/config.mjs src/voice.mjs test/e2e.test.mjs test/stubs/voiceio.mjs
git commit -m "Send Claude what Whisper heard, not what Apple heard

Apple's recognizer keeps driving the interface — partials, barge-in and
endpointing all still run off its live stream, which is what it is good
at. What changes is the one place accuracy is felt: the text that becomes
the turn is now re-derived from the turn's own audio by a local Whisper.

Guarded on both sides. Whisper failing, hanging or returning nothing
leaves Apple's text in place, and a transcription that looks like a
hallucination from silence is refused outright rather than becoming a
turn nobody spoke.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Install it, and say so

**Files:**
- Create: `scripts/install-whisper.sh`, `scripts/whisper_server.py`
- Modify: `package.json`, `README.md`

**Interfaces:**
- Consumes: the model chosen in Task 1
- Produces: `npm run install-whisper`

- [ ] **Step 1: Write the server**

```bash
cat > scripts/whisper_server.py <<'SH'
"""Long-lived Whisper transcriber.

Loading the model costs seconds, so it happens once at startup rather than per
turn. Reads {"id", "pcm", "sampleRate"} lines on stdin — pcm is base64 float32
little-endian mono — and writes {"type": "text", "id", "text"} back.

English is forced rather than detected: detection costs a pass over the audio
and this project is an English voice interface. The accent is the point, not
the language.
"""

import base64
import json
import sys

import numpy as np
from faster_whisper import WhisperModel


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "base"
    try:
        model = WhisperModel(name, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001 - report and exit; the parent falls back
        emit({"type": "error", "message": f"failed to load {name}: {exc}"})
        return 1

    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("cmd") == "quit":
            return 0
        try:
            audio = np.frombuffer(base64.b64decode(message["pcm"]), dtype=np.float32)
            segments, _ = model.transcribe(audio, language="en", beam_size=1)
            text = " ".join(s.text for s in segments).strip()
            emit({"type": "text", "id": message.get("id"), "text": text})
        except Exception as exc:  # noqa: BLE001 - one bad turn must not end the process
            emit({"type": "error", "id": message.get("id"), "message": str(exc)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
SH
```

- [ ] **Step 2: Write the installer**

```bash
cat > scripts/install-whisper.sh <<'SH'
#!/bin/bash
# Installs local Whisper for recognition, into the venv Piper already uses.
#
# Everything stays on this machine: no API key, no per-word cost, no audio
# leaving the laptop — the same promise the rest of this project makes.
set -euo pipefail

cd "$(dirname "$0")/.."
green=$'\033[38;5;114m'; amber=$'\033[38;5;179m'; dim=$'\033[2m'; reset=$'\033[0m'

MODEL="${1:-base}"

if [ ! -x vendor/py/bin/python ]; then
  echo "creating python environment…"
  python3 -m venv vendor/py
  vendor/py/bin/pip install -q --upgrade pip
fi

if ! vendor/py/bin/python -c "import faster_whisper" 2>/dev/null; then
  echo "installing faster-whisper…"
  vendor/py/bin/pip install -q faster-whisper
fi

# Downloading the model here rather than on the first spoken turn: a two minute
# silence the first time you talk to it looks exactly like the app being broken.
echo "fetching the $MODEL model…"
vendor/py/bin/python - "$MODEL" <<'PY'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("model ready")
PY

# Prove it works now, so a failure later is known to be something else.
printf '%schecking…%s\n' "$dim" "$reset"
if vendor/py/bin/python -c "
import numpy as np, sys
from faster_whisper import WhisperModel
m = WhisperModel('$MODEL', device='cpu', compute_type='int8')
segments, _ = m.transcribe(np.zeros(16000, dtype=np.float32), language='en')
list(segments)
" 2>/dev/null; then
  printf '%s✓%s whisper is installed and runs\n' "$green" "$reset"
  printf '\n  Set %s"stt": "whisper"%s in config.json to use it.\n\n' "$dim" "$reset"
else
  printf '%s✗%s whisper installed but would not run\n' "$amber" "$reset"
  exit 1
fi
SH
chmod +x scripts/install-whisper.sh
```

- [ ] **Step 3: Add the npm script**

```bash
python3 -c "
import json
p='package.json'; d=json.load(open(p))
d['scripts']['install-whisper']='./scripts/install-whisper.sh'
json.dump(d, open(p,'w'), indent=2); open(p,'a').write('\n')"
```

- [ ] **Step 4: Run it**

Run: `npm run install-whisper`
Expected: `✓ whisper is installed and runs`

- [ ] **Step 5: Document it in the README**

Add after the "### The voice" section, before "## Troubleshooting":

```markdown
### The ears

Recognition runs in two places at once. Apple's on-device recognizer drives what
you see and feel — the live transcript, interrupting it mid-sentence, and knowing
when your turn ended. **Whisper**, running locally, supplies the text that
actually reaches Claude.

The split exists because those are different jobs. Apple's recognizer is fast and
perfectly good at "have two words been said". It is less good at an accent it was
not tuned for, and that is exactly where it matters — the words Claude reads.

    npm run install-whisper

That fetches the engine and a model into `vendor/`. Nothing leaves the machine,
and there is no API key.

Set `"stt": "apple"` to turn it off and go back to Apple's text everywhere.
`"whisperModel"` takes any faster-whisper model name; larger is more accurate and
slower, and `scripts/measure-whisper.sh SAMPLE.wav` prints both numbers for your
own voice so the choice is yours rather than a guess.

**What this does not fix.** Whisper transcribes a finished utterance, so it adds
its own time to every turn, and it cannot make the answer arrive faster — the
`claude` CLI floor described under [Speed](#speed) is unchanged.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/install-whisper.sh scripts/whisper_server.py package.json README.md
git commit -m "Install local Whisper, and explain why there are two recognizers

Recognition now runs in two places, which is worth explaining rather than
leaving somebody to discover in the source. Apple's recognizer drives
what you see and feel; Whisper supplies the words Claude reads. They are
different jobs and the split is deliberate.

The installer downloads the model up front. Fetching it on the first
spoken turn instead would mean a two minute silence the first time
somebody talks to it, which looks exactly like the app being broken.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification

```bash
npm test                       # node + swift suites
./build.sh                     # three binaries
npm run install-whisper        # ✓ installed and runs
npm start                      # terminal workflow unchanged
```

By hand: speak a sentence the old recognizer got wrong, and confirm the
transcript reaching Claude is the better one. Then set `"stt": "apple"`, restart,
and confirm the old behaviour returns — the fallback path is the one that must
never be broken.
