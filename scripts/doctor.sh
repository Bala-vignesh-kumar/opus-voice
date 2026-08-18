#!/bin/bash
# Collects everything needed to diagnose a failed install into one file.
#
# Exists because "it failed" is not something anyone can act on, and asking a
# person to reproduce a failure while copying the right parts of their terminal
# never works. This runs the failing step itself and captures all of it.
#
#   ./scripts/doctor.sh          then send the file it names
#
# Deliberately no `set -e`: a doctor that stops at the first sick thing is
# useless. Every check runs and records what happened.

cd "$(dirname "$0")/.."

OUT="opus-voice-diagnostics.txt"
: > "$OUT"

say()  { printf '%s\n' "$*" | tee -a "$OUT"; }
only() { printf '%s\n' "$*" >> "$OUT"; }
run()  {
  only ""
  only "\$ $*"
  # stdbuf keeps ordering sane when a command buffers; harmless if absent.
  "$@" >> "$OUT" 2>&1
  only "[exit $?]"
}

say "collecting diagnostics into $OUT — this takes a minute…"

only "opus voice diagnostics"
only "generated $(date)"
only "========================================"

only ""
only "---------- machine ----------"
run sw_vers
run uname -m
run node --version
run npm --version
run python3 --version
run swiftc --version
run xcode-select -p

only ""
only "---------- opus voice ----------"
run git rev-parse --short HEAD
run git status --short
only ""
only "\$ cat config.json"
cat config.json >> "$OUT" 2>&1
only "[exit $?]"

only ""
only "---------- claude cli ----------"
run claude --version

only ""
only "---------- the voice model ----------"
run ls -la vendor/voices
run ls -la vendor/py/bin

# Which voice is actually configured, since that decides the download URL.
VOICE="$(node -e 'import("./src/config.mjs").then(m => process.stdout.write(m.loadConfig().piperVoice))' 2>/dev/null || echo en_US-hfc_female-medium)"
only ""
only "configured voice: $VOICE"

LOCALE="${VOICE%%-*}"; FAMILY="${LOCALE%%_*}"
SUFFIX="${VOICE#*-}"; NAME="${SUFFIX%-*}"; QUALITY="${SUFFIX##*-}"
BASE="${PIPER_VOICES_URL:-https://huggingface.co/rhasspy/piper-voices/resolve/main}/$FAMILY/$LOCALE/$NAME/$QUALITY/$VOICE"
only "download url:     $BASE.onnx"

only ""
only "---------- can this machine reach the download ----------"
# Headers only: proves reachability, DNS, TLS and any proxy interception
# without pulling 60MB.
run curl -sSIL --connect-timeout 20 -o /dev/null \
  -w "http %{http_code}  size %{size_download}  content-length %{size_header}  time %{time_total}s  final %{url_effective}\n" \
  "$BASE.onnx"

only ""
only "---------- the failing step, in full ----------"
say "  re-running the voice install (this is the part that fails)…"
run ./scripts/install-piper.sh "$VOICE"

only ""
only "---------- speech recognition ----------"
run ls -la "$HOME/Library/Assistant/SpeechModels"
run defaults read com.apple.assistant.support "Dictation Enabled"

say ""
say "done."
say ""
say "  Send this file:  $(pwd)/$OUT"
say ""
say "  It has your machine's versions, the download URL, and the full output of"
say "  the step that failed. Check it before sharing if you'd rather not send"
say "  your working directory path."
