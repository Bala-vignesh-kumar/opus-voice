#!/bin/bash
# opus voice — one-command install.
#
# Safe to re-run: every step checks whether it already happened. Works both as
# ./install.sh in a clone and piped from curl, in which case it clones first.
#
# The one thing this cannot do for you is sign in to Claude. That is a browser
# flow tied to your account, so it is reported at the end rather than attempted.
set -uo pipefail

REPO="https://github.com/Bala-vignesh-kumar/opus-voice.git"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[38;5;203m'
green=$'\033[38;5;114m'; amber=$'\033[38;5;179m'; reset=$'\033[0m'

step()  { printf '\n%s==>%s %s\n' "$bold" "$reset" "$1"; }
info()  { printf '    %s%s%s\n' "$dim" "$1" "$reset"; }
fail()  { printf '    %s✗ %s%s\n' "$red" "$1" "$reset"; }

# Every check records its outcome here so the summary at the end reflects what
# actually happened rather than what was attempted.
RESULTS=()
NEEDS_USER=()
ok()      { RESULTS+=("ok|$1"); printf '    %s✓%s %s\n' "$green" "$reset" "$1"; }
bad()     { RESULTS+=("bad|$1"); fail "$1"; }
todo()    { RESULTS+=("todo|$1"); NEEDS_USER+=("$1"); printf '    %s!%s %s\n' "$amber" "$reset" "$1"; }

die() {
  printf '\n%s✗ %s%s\n\n' "$red" "$1" "$reset"
  exit 1
}

# ---------------------------------------------------------------- environment

step "checking this machine"

[ "$(uname -s)" = "Darwin" ] || die "opus voice is macOS only (the audio engine and speech recognizer are Apple frameworks)."
ok "macOS $(sw_vers -productVersion) on $(uname -m)"

# Xcode command line tools supply swiftc. The installer is a GUI prompt, so if
# it has to be triggered the script stops rather than looping on a missing tool.
if xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; then
  ok "swift toolchain"
else
  info "requesting the Xcode command line tools…"
  xcode-select --install >/dev/null 2>&1 || true
  die "install the Xcode command line tools when the dialog appears, then re-run this script."
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())' 2>/dev/null)"
else
  bad "python3 missing — needed by the Piper speech engine"
  die "install python3 (xcode-select --install usually provides it), then re-run."
fi

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 18 ] 2>/dev/null; then
  ok "node $(node -v)"
else
  if command -v node >/dev/null 2>&1; then
    info "node $(node -v) is too old, need 18 or newer"
  else
    info "node not found"
  fi
  if command -v brew >/dev/null 2>&1; then
    info "installing node with homebrew…"
    brew install node || die "homebrew could not install node."
  else
    die "install node 18+ (https://nodejs.org) or homebrew, then re-run."
  fi
  [ "$(node_major)" -ge 18 ] 2>/dev/null || die "node is still older than 18 after install."
  ok "node $(node -v)"
fi

# ---------------------------------------------------------------- the source

# Piped from curl there is no repo around us, so fetch one.
if [ -f "package.json" ] && grep -q '"opus-voice"' package.json 2>/dev/null; then
  cd "$(pwd)"
elif [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/package.json" ]; then
  cd "$(dirname "${BASH_SOURCE[0]}")"
else
  step "fetching opus voice"
  DEST="${OPUS_VOICE_DEST:-$HOME/opus-voice}"
  if [ -d "$DEST/.git" ]; then
    info "updating $DEST"
    git -C "$DEST" pull --ff-only || info "could not fast-forward, using what is there"
  else
    command -v git >/dev/null 2>&1 || die "git not found."
    git clone --depth 1 "$REPO" "$DEST" || die "could not clone $REPO"
  fi
  cd "$DEST"
  ok "source in $DEST"
fi

ROOT="$(pwd)"

# ---------------------------------------------------------------- build

step "installing node packages"
if npm install --no-audit --no-fund; then
  ok "node packages"
else
  bad "npm install failed"
  die "npm install failed — the output above says why."
fi

step "building the audio daemon"
# This owns the microphone, the recognizer and playback in one process, because
# echo cancellation only works on audio rendered through its own engine.
if ./build.sh; then
  ok "bin/voiceio (audio daemon)"
else
  bad "swift build failed"
  die "the swift build failed — the compiler output above says why."
fi

if [ -x bin/voiceapp ]; then
  ok "bin/voiceapp (desktop window)"
else
  todo "desktop window did not build — 'npm start' still works in the terminal"
fi

# ---------------------------------------------------------------- the voice

step "installing the neural voice"

# espeak-ng, which Piper phonemizes with, holds its data path in a fixed 160
# character buffer. Installed somewhere deep enough to overflow it, it silently
# falls back to a build path that does not exist on this machine and every
# synthesis fails. Catching it here beats debugging a robotic voice later.
DEPTH=${#ROOT}
if [ "$DEPTH" -gt 90 ]; then
  todo "install path is ${DEPTH} characters — too deep for the speech engine, move it somewhere shorter like ~/opus-voice"
fi

VOICE="$(node -e 'import("./src/config.mjs").then(m => process.stdout.write(m.loadConfig().piperVoice))' 2>/dev/null || echo en_US-hfc_female-medium)"
MODEL="vendor/voices/$VOICE.onnx"

if [ -s "$MODEL" ] && [ -s "$MODEL.json" ] && [ -x vendor/py/bin/python ]; then
  info "$VOICE already installed"
else
  ./scripts/install-piper.sh "$VOICE" || info "piper install reported a problem — verifying anyway"
fi

# Trust the files on disk, not the installer's exit code: a truncated download
# leaves a file that exists and is unusable.
if [ -s "$MODEL" ] && [ -s "$MODEL.json" ]; then
  SIZE=$(( $(wc -c < "$MODEL") / 1000000 ))
  if [ "$SIZE" -lt 5 ]; then
    bad "voice model is only ${SIZE}MB — the download was truncated"
    info "delete vendor/voices and re-run this script"
  else
    # Synthesizing once proves the whole chain works, not just that a file exists.
    if vendor/py/bin/python - "$VOICE" >/dev/null 2>&1 <<'PY'
import sys
from piper import PiperVoice
name = sys.argv[1]
voice = PiperVoice.load(f"vendor/voices/{name}.onnx", config_path=f"vendor/voices/{name}.onnx.json")
total = sum(len(c.audio_int16_bytes) for c in voice.synthesize("Installation complete."))
sys.exit(0 if total > 1000 else 1)
PY
    then
      ok "neural voice $VOICE (${SIZE}MB, synthesis verified)"
    else
      bad "the voice model is installed but synthesis failed"
      info "opus voice will fall back to the system voice"
    fi
  fi
else
  bad "voice model missing — falling back to the system voice"
  info "re-run ./scripts/install-piper.sh to retry the download"
fi

# ---------------------------------------------------------------- settings

step "settings"
if [ -f config.json ]; then
  ok "config.json (kept — your settings were not touched)"
else
  cp config.example.json config.json
  ok "config.json created from the example"
fi

# ---------------------------------------------------------------- claude cli

step "claude code"

if command -v claude >/dev/null 2>&1; then
  ok "claude cli $(claude --version 2>/dev/null | head -1)"
else
  info "installing the claude cli…"
  if command -v npm >/dev/null 2>&1 && npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then
    ok "claude cli installed"
  elif curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1; then
    ok "claude cli installed"
  else
    bad "could not install the claude cli"
    info "install it manually: npm install -g @anthropic-ai/claude-code"
  fi
fi

# Auth is a browser flow tied to a person's account. It is checked, never faked,
# and never satisfied with an API key — this runs on your existing subscription.
if command -v claude >/dev/null 2>&1; then
  # This round-trips a real prompt, so it takes several seconds and prints
  # nothing while it runs. Say so, or the script looks frozen here.
  info "checking sign-in (one round trip, up to 90s)…"
  # No `timeout` on macOS, so the cap comes from perl's alarm. Without a cap an
  # unauthenticated CLI can sit waiting on a browser flow forever.
  if echo "hi" | perl -e 'alarm 90; exec @ARGV or exit 1' claude --print --model haiku >/dev/null 2>&1; then
    ok "signed in to claude"
  else
    todo "claude is not signed in yet"
  fi
fi

# ---------------------------------------------------------------- dictation

step "dictation"

# Apple's speech recognizer refuses to run at all when Dictation is off, even
# over the network. This is the single most common reason it hears nothing.
DICT_ON=no
if [ "$(defaults read com.apple.assistant.support "Dictation Enabled" 2>/dev/null)" = "1" ]; then DICT_ON=yes; fi
if [ "$(defaults read com.apple.speech.recognition.AppleSpeechRecognition.prefs DictationIMMasterDictationEnabled 2>/dev/null)" = "1" ]; then DICT_ON=yes; fi

if [ "$DICT_ON" = "yes" ]; then
  if [ -d "$HOME/Library/Assistant/SpeechModels" ] && [ -n "$(ls -A "$HOME/Library/Assistant/SpeechModels" 2>/dev/null)" ]; then
    ok "dictation on, on-device speech model present"
  else
    todo "dictation is on but the on-device model has not downloaded — recognition will go over the network and mis-hear names"
  fi
else
  todo "dictation is off — speech recognition cannot start at all"
fi

# ---------------------------------------------------------------- summary

printf '\n%s────────────────────────────────────────────%s\n' "$dim" "$reset"
printf '%sinstall summary%s\n\n' "$bold" "$reset"

for entry in "${RESULTS[@]}"; do
  status="${entry%%|*}"; label="${entry#*|}"
  case "$status" in
    ok)   printf '  %s✓%s %s\n' "$green" "$reset" "$label" ;;
    todo) printf '  %s!%s %s\n' "$amber" "$reset" "$label" ;;
    *)    printf '  %s✗%s %s\n' "$red" "$reset" "$label" ;;
  esac
done

if [ ${#NEEDS_USER[@]} -gt 0 ]; then
  printf '\n%s╭──────────────────────────────────────────╮%s\n' "$amber" "$reset"
  printf '%s│  two minutes of setup only you can do    │%s\n' "$amber" "$reset"
  printf '%s╰──────────────────────────────────────────╯%s\n\n' "$amber" "$reset"

  for item in "${NEEDS_USER[@]}"; do
    case "$item" in
      *"signed in"*)
        printf '  %sSign in to Claude%s\n' "$bold" "$reset"
        printf '    Run:  claude\n'
        printf '    Pick "Claude account with subscription" and sign in in the browser.\n'
        printf '    You do not need an API key. Then re-run ./install.sh.\n\n'
        ;;
      *"dictation is off"*)
        printf '  %sTurn on Dictation%s\n' "$bold" "$reset"
        printf '    System Settings › Keyboard › Dictation → On\n'
        printf '    Accept the prompt, then wait for the language download to finish.\n'
        printf '    Without this the recognizer will not start at all.\n\n'
        ;;
      *"on-device model"*)
        printf '  %sWait for the speech model%s\n' "$bold" "$reset"
        printf '    System Settings › Keyboard › Dictation — leave it on and connected\n'
        printf '    until the language finishes downloading. Until then names get mangled.\n\n'
        ;;
      *)
        printf '  %s%s%s\n\n' "$bold" "$item" "$reset"
        ;;
    esac
  done
fi

printf '%sstart it%s\n\n' "$bold" "$reset"
printf '    cd %s\n' "$ROOT"
printf '    npm run app        %s# desktop window%s\n' "$dim" "$reset"
printf '    npm start          %s# terminal%s\n\n' "$dim" "$reset"
printf '  %sThen say "falcon".%s\n\n' "$dim" "$reset"
