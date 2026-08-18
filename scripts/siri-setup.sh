#!/bin/bash
# Sets up waking by "Hey Siri" instead of holding the microphone.
#
# Third-party apps cannot register a wake word on macOS. The always-on detector
# that hears "Hey Siri" runs on dedicated low-power silicon, outside the normal
# audio path, and there is no API to that. Any app that wants to hear its own
# name has to hold the microphone open, which is why the orange indicator stays
# lit for as long as it runs.
#
# The way around it is to let Siri do the listening. A Shortcut is something Siri
# can already run by name, so a Shortcut that pokes this app turns Apple's wake
# word into ours — and opus voice can then keep the microphone closed until it
# is actually wanted.
set -euo pipefail

cd "$(dirname "$0")/.."

bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[38;5;114m'
amber=$'\033[38;5;179m'; reset=$'\033[0m'

WAKE_DIR="$HOME/.opus-voice"
WAKE_FILE="$WAKE_DIR/wake"
HOOK="$WAKE_DIR/wake.sh"

PHRASE="$(node -e 'import("./src/config.mjs").then(m => process.stdout.write(m.loadConfig().siriPhrase || "falcon"))' 2>/dev/null || echo falcon)"

mkdir -p "$WAKE_DIR"
cat > "$HOOK" <<EOF
#!/bin/bash
# Poked by a Shortcut; opus voice watches this file and wakes when it changes.
#
# Shortcuts runs shell actions in a sandbox with a stripped PATH, so no external
# command can be assumed to exist — even \`touch\` fails with "No such file or
# directory". A redirect and \$RANDOM are both bash builtins, need no PATH, and
# change the file's contents as well as its timestamp.
printf '%s\\n' "\$RANDOM" > "$WAKE_FILE" || exit 1
EOF
chmod +x "$HOOK"
touch "$WAKE_FILE"

printf '\n%s✓%s wake hook installed at %s\n' "$green" "$reset" "$HOOK"

# Prove the hook works now, so a failure later is known to be the Shortcut and
# not this half.
if "$HOOK" && [ -f "$WAKE_FILE" ]; then
  printf '%s✓%s it runs and updates %s\n' "$green" "$reset" "$WAKE_FILE"
else
  printf '%s✗%s the hook did not run\n' "$amber" "$reset"
  exit 1
fi

if shortcuts list 2>/dev/null | grep -qix "$PHRASE"; then
  printf '%s✓%s a shortcut named "%s" already exists\n' "$green" "$reset" "$PHRASE"
  printf '\n  Test it:  %sshortcuts run "%s"%s\n' "$dim" "$PHRASE" "$reset"
  printf '  Or say:   %s"Hey Siri, %s"%s\n\n' "$dim" "$PHRASE" "$reset"
  exit 0
fi

# Shortcuts have to be signed to be imported, so this cannot be created for you.
# Four steps, once.
cat <<EOF

${bold}One thing left, and it has to be done by hand${reset}

Shortcuts are signed, so this script cannot create one for you. Once only:

  1. Open ${bold}Shortcuts${reset} and make a new shortcut
  2. Add the action ${bold}Run Shell Script${reset}
     (search "shell" — it is under Scripting)
  3. Put exactly this in it:

       ${bold}$HOOK${reset}

  4. Name the shortcut ${bold}$PHRASE${reset}
     ${dim}This name is what you say. Pick something Siri will not confuse with
     an app or a contact — one or two distinct words.${reset}

Then say ${bold}"Hey Siri, $PHRASE"${reset}.

${bold}And set this in config.json${reset}

    "holdMic": false

That is what makes opus voice release the microphone while it sleeps. Without
it the app still works, but it keeps the microphone open and listens for its own
wake phrase, which is the thing you are trying to avoid.

${dim}Trade-off worth knowing: with holdMic off, nothing you say can wake it.
Siri, the buttons in the window, and typing are the ways in. That is the cost of
not holding the microphone — there is no third option on this platform.${reset}

EOF
