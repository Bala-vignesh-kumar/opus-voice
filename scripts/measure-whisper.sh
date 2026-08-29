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
# transcribe() is lazy: the work happens while the generator is drained.
text = " ".join(s.text for s in segments).strip()
run = time.time() - t1
print(f"{name:8} load={load:5.1f}s  transcribe={run:5.2f}s  {text!r}")
PY
done
