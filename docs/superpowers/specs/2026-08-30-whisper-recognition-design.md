# Local Whisper for recognition

Design for replacing the text that reaches Claude with a locally-run Whisper
transcription, while leaving the live recognition that drives the interface
exactly as it is.

Status: approved in brainstorming, 2026-08-30. Not yet implemented.

## The problem

Speech is being misheard. The complaint that started this was that ChatGPT and
Claude's own voice modes "hear more like a human", and that this matters more
here because the speaker is Indian and Apple's recognizer is not tuned for that
accent.

That complaint decomposes into four gaps, and they are not equally tractable:

| gap | here | there | tractable? |
|---|---|---|---|
| recognition accuracy | Apple on-device `SpeechTranscriber` | Whisper-class model | yes, locally |
| turn-taking | fixed silence, 700ms / 400ms | semantic — the model decides | yes, separately |
| voice naturalness | Piper neural | prosody-aware neural TTS | partly |
| latency | ~2s | ~300ms | **no** |

**Latency is out of reach and saying so up front matters.** ChatGPT's Advanced
Voice is not a better version of this pipeline; it is a different architecture —
a speech-to-speech model that never converts to text, which is how it hears tone
and answers in 300ms. This project runs speech → text → LLM → text → speech, and
the README's own measurements put the `claude` CLI floor at 1000–1950ms with
model choice barely moving it. Nothing in this design changes that.

This spec covers **recognition accuracy only**. Turn-taking and voice quality are
separate specs, deliberately sequenced after this one: until the words arriving
are right, neither of the others can be judged fairly.

## Decisions

| decision | choice | why |
|---|---|---|
| Where the model runs | **Fully local** | The README promises "no API key, no per-word cost, no audio leaving the machine". That promise is worth more than the last few points of accuracy, and Whisper is good enough locally to close most of the gap. |
| Pipeline shape | **Hybrid**: Apple live, Whisper final | Whisper is batch and emits no partials. A straight swap would silently kill the interim line, word-based barge-in and endpointing — three tuned features. |
| Engine | **Measured, not assumed** | The Python route is the easiest install and may be too slow; whisper.cpp is faster and costs a new build dependency. This is settled by a probe, not by argument. |
| Failure behaviour | **Always fall back to Apple** | Losing a turn because the nicer recognizer was unavailable is worse than a less accurate turn. |

## Architecture

```
                    ┌────────────────────────────────────────┐
  mic tap ──┬──────►│ Apple SpeechTranscriber                │──► partials
            │       │ (interim line, barge-in, endpointing)  │    unchanged
            │       └────────────────────────────────────────┘
            │
            └──────►┌────────────────────────┐
                    │ utterance buffer       │  16kHz mono float32
                    │ reset each turn, 30s   │
                    └───────────┬────────────┘
                                │ on endpoint
                                ▼
                    ┌────────────────────────┐
                    │ Whisper, local         │──► final text ──► Claude
                    └───────────┬────────────┘
                                │ missing, failed, slow, empty
                                ▼
                          Apple's text
```

The whole change is one substitution. Today the endpoint timer emits
`{"type":"final","text": partial}` carrying Apple's text. It will emit Whisper's
transcription of the audio that produced that partial.

**Barge-in and the interim line never touch Whisper.** They stay on Apple's live
stream, which is what makes this cheap: Whisper's latency is paid once per turn,
at the only point where accuracy matters. Apple's recognizer is entirely adequate
for "have two words been said", which is all barge-in asks of it.

### The utterance buffer

Lives in `VoiceIO.startInput()`'s microphone tap — the single point every audio
buffer already passes through.

- Mono float32, resampled to 16kHz, which is what Whisper expects.
- **Reset at every turn boundary**, so an utterance is exactly "audio since the
  last turn". No windowing, no guessing where speech began.
- **Capped at 30 seconds.** A forgotten open microphone must not grow without
  limit, and no single spoken turn is longer than that.

### Where Whisper runs

To be decided by measurement (see *Implementation order*). The candidates:

**Python `faster-whisper` in the existing venv.** `vendor/py` already exists for
Piper and `scripts/piper_server.py` is exactly the shape needed: a long-lived
process that loads its model once and speaks newline-delimited JSON. Install is
`pip install faster-whisper` into a venv that is already there, and `src/piper.mjs`
is a supervisor that `src/whisper.mjs` can be modelled on line for line. The risk
is speed: CTranslate2 is CPU-only, with no Metal and no Neural Engine.

**`whisper.cpp` as a subprocess.** Metal-accelerated and substantially faster, at
the cost of needing `cmake`, which the Xcode command line tools do not ship. That
is a new dependency in a project whose install is currently one command.

**`whisper.cpp` linked into `voiceio`.** One process, no IPC, no WAV round trip,
fastest of the three. Also the most fiddly: C++ interop from bare `swiftc`, and
Metal shaders to ship alongside the binary. Only worth it if the other two prove
too slow.

Whichever wins, the boundary is the same: `src/whisper.mjs` exposes
`transcribe(pcm) → Promise<string>`, and `voiceio` gains an `utterance` event
carrying the buffered audio. Changing engines later changes one module.

## Configuration

Mirrors the existing TTS keys, so there is one idea to learn rather than two:

| key | default | meaning |
|---|---|---|
| `stt` | `whisper` | `whisper` (local) or `apple` (system recognizer) |
| `whisperModel` | `small` | model size; the measurement may change this default before implementation, and records why |
| `whisperTimeoutMs` | `3000` | after this, use Apple's text for that turn |

## Failure handling

Every failure falls back to Apple's text. None of them loses a turn.

| failure | behaviour |
|---|---|
| model not installed | warn once at startup, `stt` degrades to `apple` for the session |
| subprocess crashes | warn, degrade for the session, do not retry-loop |
| transcription exceeds `whisperTimeoutMs` | Apple's text for that turn; Whisper still used for the next |
| returns empty | Apple's text |
| empty or silent audio buffer | no turn at all — the existing `isSpeech` guard |

`src/speaker.mjs` already degrades Piper to Apple exactly this way. That is the
pattern to copy rather than reinvent.

### Hallucinated turns

Whisper hallucinates on silence and noise. Fed near-silent audio it confidently
emits stock phrases — "Thank you.", "Thanks for watching!" — which are artefacts
of its training data. In a voice assistant that means unprompted turns arriving
from nothing, which is the same class of bug as the bare `.` that reached Claude
and was answered with "Still here."

Two guards before Whisper text becomes a turn:

1. **Energy floor.** Reject if the buffered audio never rises above the level
   the microphone meter already reports for the live display, sustained for at
   least 200ms. The measurement exists; this reuses it rather than adding a
   second notion of loudness. The threshold is set from the recordings made
   during the measurement task, not guessed.
2. **Known-phrase list.** Reject a short list of stock hallucinations when they
   are the *entire* output. Never when they appear inside a longer sentence —
   "thank you" is a thing people say.

Both are pure functions and both are tested.

## Testing

| unit | how |
|---|---|
| utterance buffer | pure Swift unit: resets at turn boundary, caps at 30s, resamples to 16kHz. No audio device, via the existing `scripts/test-swift.sh` harness. |
| hallucination guards | pure unit, table-driven, including the real stock phrases and the "inside a longer sentence" case. |
| `src/whisper.mjs` | node tests against a stub subprocess, mirroring `test/stubs/claude.mjs`. |
| fallback behaviour | end-to-end: stub `voiceio` emits an utterance, Whisper stub fails, assert Apple's text still reaches Claude and the turn survives. |
| the engine choice | the measurement's results recorded in this spec, so the choice has evidence attached rather than becoming folklore. |

## Implementation order

**The first task is a measurement, not code that is kept.**

Record several sentences in the user's own voice, including ones the current
recognizer demonstrably gets wrong, and transcribe each through:

1. Apple `SpeechTranscriber` — the baseline
2. `faster-whisper` at `base`, `small`, `medium`
3. `whisper.cpp` at the same sizes, if the Python route is too slow

Report a table of **accuracy against what was actually said** and **wall-clock
transcription time**. Choose the row that is both good enough and fast enough,
record it here, and write the rest of the plan against that choice.

An hour spent finding out beats a day spent building on an assumption about
CTranslate2's speed on Apple Silicon.

## Out of scope

- Turn-taking and semantic endpointing — its own spec, after this one
- Voice naturalness and Indian-English TTS voices — its own spec
- Any reduction in end-to-end latency; the CLI floor is unchanged
- Cloud recognition of any kind
- Languages other than English; `locale` continues to select the Apple recognizer's
  accent, and Whisper is run in English mode

## Risks

1. **Whisper is too slow to be worth it.** The measurement answers this before
   anything is built on top of it. If every local option costs more than about a
   second, the honest outcome is to keep Apple's recognizer and say so.
2. **Added latency is felt.** Whisper's time is added to a turn that already
   costs 1–2s. Mitigated by choosing the smallest model that is accurate enough,
   which is what the measurement is for.
3. **Hallucinated turns.** Guarded above, and the guards are tested — but a
   phrase list is never complete, so the energy floor is the real defence.
4. **Two engines running.** Both consume the same microphone tap rather than the
   device, so this does not repeat the two-process contention that made
   recognition unusable during development.
