// Checking that the Siri side of waking is actually set up.
//
// With the microphone released, a Shortcut is the only thing that can wake the
// app by voice. Siri finds a Shortcut by its name and nothing else, so a
// correctly built Shortcut under the wrong name is invisible — and the symptom
// is an app that ignores you, which looks like the app is broken.
//
// Shortcuts names a new shortcut after its first action, so one built from the
// setup instructions and never renamed ends up called "Run Shell Script". That
// is common enough to be worth naming explicitly.

import { execFile } from 'node:child_process';

/** @returns {Promise<string[]>} shortcut names, or [] if they cannot be read. */
export function listShortcuts(timeout = 5000) {
  return new Promise((resolve) => {
    execFile('shortcuts', ['list'], { timeout }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      resolve(String(stdout).split('\n').map((line) => line.trim()).filter(Boolean));
    });
  });
}

/**
 * Whether Siri can find the shortcut, and what to say if it cannot.
 *
 * @returns {Promise<{ok: boolean, message: string|null}>}
 */
export async function checkShortcut(phrase) {
  const names = await listShortcuts();
  // No CLI, or no shortcuts at all: nothing useful to say that setup does not
  // already say better, so stay quiet rather than nagging.
  if (names.length === 0) return { ok: false, message: null };

  const wanted = String(phrase).toLowerCase();
  if (names.some((name) => name.toLowerCase() === wanted)) return { ok: true, message: null };

  if (names.some((name) => name.toLowerCase() === 'run shell script')) {
    return {
      ok: false,
      message: `no shortcut named "${phrase}" — found "Run Shell Script", which is the unrenamed default`,
    };
  }
  return { ok: false, message: `no shortcut named "${phrase}" — found: ${names.join(', ')}` };
}
