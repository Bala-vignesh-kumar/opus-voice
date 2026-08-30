#!/bin/bash
# Installs local Whisper for recognition, into the venv Piper already uses.
#
# Everything stays on this machine: no API key, no per-word cost, no audio
# leaving the laptop — the same promise the rest of this project makes.
set -euo pipefail

cd "$(dirname "$0")/.."
green=$'\033[38;5;114m'; amber=$'\033[38;5;179m'; dim=$'\033[2m'; bold=$'\033[1m'; reset=$'\033[0m'

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

# Fetched here rather than on the first spoken turn: a minutes-long silence the
# first time you talk to it looks exactly like the app being broken.
echo "fetching the $MODEL model…"
vendor/py/bin/python - "$MODEL" <<'PY'
import sys, warnings
warnings.filterwarnings("ignore")
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
PY

# Prove it transcribes now, so a failure later is known to be something else.
printf '%schecking…%s\n' "$dim" "$reset"
if vendor/py/bin/python - "$MODEL" <<'PY' 2>/dev/null
import sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
segments, _ = m.transcribe(np.zeros(16000, dtype=np.float32), language="en")
list(segments)
PY
then
  printf '\n%s✓%s whisper is installed and transcribes\n' "$green" "$reset"
  printf '\n  It is on by default. %s"stt": "apple"%s in config.json turns it off.\n' "$dim" "$reset"
  printf '  %s./scripts/measure-whisper.sh SAMPLE.wav%s prints speed for your own voice.\n\n' "$dim" "$reset"
else
  printf '\n%s✗%s whisper installed but would not transcribe\n' "$amber" "$reset"
  printf '  Falcon still works — it will use the system recognizer.\n\n'
  exit 1
fi
