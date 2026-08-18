// Configuration: defaults, config.json, then --flag overrides.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  model: 'opus',
  effort: 'medium',
  dir: '',                  // project it works in; empty = where you launched it
  permissionMode: 'bypassPermissions',
  narrateTools: true,
  locale: 'en-IN',          // accent the recognizer listens for
  tts: 'piper',             // 'piper' (local neural) or 'apple' (system voice)
  piperVoice: 'en_US-hfc_female-medium',
  voice: '',                // Apple voice name; empty = best installed English
  rate: 0.52,
  pitch: 1.0,
  endpointMs: 700,          // silence that ends your turn mid-sentence
  endpointFastMs: 400,      // silence needed when you clearly finished a sentence
  bargeInWords: 2,          // words needed to interrupt, guards against stray noise
  fillerDelayMs: 250,       // grace period before the "let me think" beat
  wakeWord: true,           // require the wake phrase before it answers anything
  wakePhrase: 'hey falcon', // two words on purpose — see src/wake.mjs
  awakeTimeoutMs: 30000,    // silence in awake or chat mode before it sleeps again
  greeting: 'Say hey falcon when you need me.',
  showIgnored: false,       // record speech heard while asleep in the transcript
  // false: hand the microphone back whenever it sleeps, so nothing is held
  // between conversations and Siri does the waking. true: keep it open and
  // listen for the wake phrase, which means holding the device the whole time.
  holdMic: false,
  siriPhrase: 'falcon',     // the Shortcut's name, said as "hey siri, falcon"


  ui: false,                // open the desktop window (npm run app sets this)
  uiPort: 4477,             // loopback port for the window; steps up if taken
};

export function loadConfig(argv = process.argv.slice(2)) {
  let config = { ...DEFAULTS };

  // Tests run against the defaults on purpose. Reading whatever config.json
  // happens to be on the machine made the suite depend on local settings, so a
  // developer changing one broke tests that had nothing to do with it.
  const file = path.join(ROOT, 'config.json');
  if (!process.env.OPUS_VOICE_IGNORE_CONFIG && fs.existsSync(file)) {
    try {
      config = { ...config, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      console.error(`ignoring invalid config.json: ${err.message}`);
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([\w-]+)$/.exec(argv[i]);
    if (!match) continue;
    const key = match[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
    if (!(key in config)) continue;
    // A boolean flag stands alone: `--ui` means on, and `--ui false` turns it
    // off, so a bare flag never swallows the next argument as its value.
    if (typeof DEFAULTS[key] === 'boolean') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        config[key] = next === 'true';
        i += 1;
      } else {
        config[key] = true;
      }
      continue;
    }

    const value = argv[i + 1];
    config[key] = typeof DEFAULTS[key] === 'number' ? Number(value) : value;
    i += 1;
  }

  return config;
}

/** The project the session can read and edit. */
export function resolveWorkdir(config) {
  // INIT_CWD is where `npm start` was invoked from, which beats process.cwd() —
  // that would be this package, not the user's code.
  return path.resolve(
    config.dir || process.env.OPUS_VOICE_DIR || process.env.INIT_CWD || process.cwd(),
  );
}
