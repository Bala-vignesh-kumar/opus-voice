#!/bin/bash
# Installs Piper, a local neural text-to-speech engine, into vendor/.
#
# Everything stays on this machine: no API key, no per-word cost, no audio
# leaving the laptop.
#
# Uses the pip package rather than the GitHub binary release: the asset named
# piper_macos_aarch64.tar.gz actually contains an x86_64 binary, which won't run
# on Apple Silicon without Rosetta. The wheel is native.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p vendor

VOICE="${1:-en_US-hfc_female-medium}"

if [ ! -x vendor/py/bin/python ]; then
  echo "creating python environment…"
  python3 -m venv vendor/py
  vendor/py/bin/pip install -q --upgrade pip
fi

if ! vendor/py/bin/python -c "import piper" 2>/dev/null; then
  echo "installing piper-tts…"
  vendor/py/bin/pip install -q piper-tts
fi

# en_US-hfc_female-medium  ->  en/en_US/hfc_female/medium
SUFFIX="${VOICE#en_US-}"
NAME="${SUFFIX%-*}"
QUALITY="${SUFFIX##*-}"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/$NAME/$QUALITY/$VOICE"

mkdir -p vendor/voices
if [ ! -f "vendor/voices/$VOICE.onnx" ]; then
  echo "downloading voice ${VOICE}…"
  curl -fsSL "$BASE.onnx" -o "vendor/voices/$VOICE.onnx"
  curl -fsSL "$BASE.onnx.json" -o "vendor/voices/$VOICE.onnx.json"
fi

echo "testing…"
vendor/py/bin/python - "$VOICE" <<'PY'
import sys, time
from piper import PiperVoice

name = sys.argv[1]
start = time.time()
voice = PiperVoice.load(f"vendor/voices/{name}.onnx", config_path=f"vendor/voices/{name}.onnx.json")
load = time.time() - start

start = time.time()
first = None
total = 0
for chunk in voice.synthesize("Piper is installed and working."):
    if first is None:
        first = time.time() - start
    total += len(chunk.audio_int16_bytes)

seconds = total / 2 / voice.config.sample_rate
elapsed = time.time() - start
print(f"  model load     {load*1000:.0f}ms")
print(f"  first audio    {first*1000:.0f}ms")
print(f"  speed          {seconds/elapsed:.1f}x realtime")
PY

echo
echo "done — set in config.json:  { \"tts\": \"piper\", \"piperVoice\": \"$VOICE\" }"
