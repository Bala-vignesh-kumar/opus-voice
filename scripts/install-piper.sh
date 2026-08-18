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
# Derived rather than hardcoded to en_US so a British or German voice resolves
# to its own directory instead of 404ing under the American one.
LOCALE="${VOICE%%-*}"          # en_US
FAMILY="${LOCALE%%_*}"         # en
SUFFIX="${VOICE#*-}"           # hfc_female-medium
NAME="${SUFFIX%-*}"
QUALITY="${SUFFIX##*-}"
# Overridable so a machine that cannot reach huggingface — blocked, rate-limited,
# or behind a proxy — can point at a mirror or a local copy of the voice tree
# instead of being stuck.
VOICES_URL="${PIPER_VOICES_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main}"
BASE="$VOICES_URL/$FAMILY/$LOCALE/$NAME/$QUALITY/$VOICE"

# The model is ~60MB, so anything under this is a truncated transfer rather than
# a real file. The config beside it is a few KB.
MIN_MODEL_BYTES=5000000

# Is what is already on disk actually usable? A half-downloaded model exists,
# has a plausible name, and fails only later inside the synthesizer.
voice_ok() {
  local onnx="vendor/voices/$VOICE.onnx"
  local conf="$onnx.json"
  [ -s "$onnx" ] && [ -s "$conf" ] || return 1
  [ "$(wc -c < "$onnx")" -ge "$MIN_MODEL_BYTES" ] || return 1
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$conf" 2>/dev/null || return 1
}

# Downloads to a scratch file and only moves it into place once it is complete,
# so an interrupted transfer can never be mistaken for an installed voice. This
# is the whole reason a failed install used to be unrecoverable: curl wrote
# straight to the final path, and every later run saw a file there and skipped
# the download.
fetch() {
  local url="$1" dest="$2" min="$3" part="$2.part"
  rm -f "$part"
  # No --continue-at: with no checksum to verify against, resuming onto a
  # corrupt part file would produce a wrong model that passes the size check.
  # curl fails a transfer that ends short of Content-Length, so each attempt is
  # all-or-nothing and --retry handles the flaky link.
  if ! curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
            --connect-timeout 20 --progress-bar "$url" -o "$part"; then
    rm -f "$part"
    echo "  could not download $url" >&2
    return 1
  fi
  if [ "$(wc -c < "$part")" -lt "$min" ]; then
    rm -f "$part"
    echo "  $url returned a file too small to be real" >&2
    return 1
  fi
  mv -f "$part" "$dest"
}

mkdir -p vendor/voices

# Clear out any wreckage from an earlier interrupted run before deciding.
rm -f "vendor/voices/$VOICE.onnx.part" "vendor/voices/$VOICE.onnx.json.part"

if voice_ok; then
  echo "voice ${VOICE} already installed"
else
  if [ -e "vendor/voices/$VOICE.onnx" ]; then
    echo "re-downloading ${VOICE}: what is on disk is incomplete"
    rm -f "vendor/voices/$VOICE.onnx" "vendor/voices/$VOICE.onnx.json"
  else
    echo "downloading voice ${VOICE}…"
  fi
  fetch "$BASE.onnx.json" "vendor/voices/$VOICE.onnx.json" 100 || {
    echo "the voice config could not be downloaded — check the name in config.json" >&2
    exit 1
  }
  fetch "$BASE.onnx" "vendor/voices/$VOICE.onnx" "$MIN_MODEL_BYTES" || {
    echo "the voice model could not be downloaded — re-run this script to try again" >&2
    exit 1
  }
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
