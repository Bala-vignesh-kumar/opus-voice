// Terminal rendering.
//
// One mutable "live" line at the bottom (interim transcript, status) with
// permanent transcript lines printed above it.

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  grey: '\x1b[38;5;245m',
  blue: '\x1b[38;5;75m',
  green: '\x1b[38;5;114m',
  amber: '\x1b[38;5;179m',
  red: '\x1b[38;5;203m',
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Ui {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.live = '';
    this.frame = 0;
    this.timer = null;
    this.status = null;
  }

  banner({ voice, model, onDevice, workdir, engine, locale, recognizer }) {
    const quality = onDevice ? 'on-device' : 'server-based';
    const spoken = engine === 'piper' ? 'piper neural' : voice;
    // Which recognizer is running is the single biggest factor in how well it
    // hears a non-US accent, so it goes in the banner rather than a debug log.
    const ears = recognizer === 'SpeechTranscriber' ? 'transcriber' : 'legacy';
    this.stream.write(`\n${C.bold}opus voice${C.reset} ${C.grey}·${C.reset} ${model} ${C.grey}·${C.reset} ${spoken} ${C.grey}·${C.reset} ${ears} ${quality} ${locale}\n`);
    // The working directory is the one thing that must never be a surprise: it
    // can edit and run commands in here.
    this.stream.write(`${C.amber}working in${C.reset} ${workdir}\n`);
    this.stream.write(`${C.grey}just talk. interrupt any time. type to send text. ctrl-c to quit.${C.reset}\n\n`);
  }

  /** Prints a permanent line, preserving whatever is on the live line. */
  print(text) {
    this.#clear();
    this.stream.write(`${text}\n`);
    this.#restore();
  }

  you(text) { this.print(`${C.blue}you${C.reset}  ${text}`); }

  /** Prints a sentence as it is handed to the synthesizer; label only leads. */
  opus(text, first) { this.print(`${first ? `${C.green}opus${C.reset}` : '    '} ${text}`); }
  note(text) { this.print(`${C.grey}     ${text}${C.reset}`); }

  /** Speech captured in note mode. */
  heard(text) { this.print(`${C.grey}  ·  ${text}${C.reset}`); }

  /** Speech ignored because it's asleep — shown so it doesn't look broken. */
  ignored(text) {
    const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    this.print(`${C.grey}  ⌁  ${short}${C.reset}`);
  }

  /** Announces a mode change and parks it on the live line. */
  mode(name) {
    const labels = {
      asleep: `${C.grey}asleep${C.reset} ${C.grey}— say "falcon" to wake${C.reset}`,
      awake: `${C.green}awake${C.reset}`,
      chat: `${C.green}chat${C.reset}`,
      note: `${C.amber}taking notes${C.reset} ${C.grey}— say "falcon stop" to finish${C.reset}`,
    };
    this.print(`${C.grey}  ›  ${C.reset}${labels[name] ?? name}`);
  }
  warn(text) { this.print(`${C.amber}  !  ${text}${C.reset}`); }
  error(text) { this.print(`${C.red}  ✗  ${text}${C.reset}`); }

  /** Interim transcript while the user is still talking. */
  hearing(text) {
    this.#stopSpinner();
    this.#setLive(`${C.grey}···  ${text}${C.reset}`);
  }

  /** Animated status such as "thinking". */
  spin(label) {
    if (this.status === label) return;
    this.status = label;
    this.#stopSpinner();
    const render = () => {
      const glyph = SPINNER[this.frame++ % SPINNER.length];
      this.#setLive(`${C.grey}${glyph}  ${label}${C.reset}`);
    };
    render();
    this.timer = setInterval(render, 80);
    this.timer.unref?.();
  }

  clearLive() {
    this.#stopSpinner();
    this.#clear();
    this.live = '';
    this.status = null;
  }

  close() {
    this.clearLive();
    this.stream.write('\n');
  }

  #setLive(text) {
    this.#clear();
    this.live = text;
    this.stream.write(text);
  }

  #clear() {
    if (this.live) this.stream.write('\r\x1b[2K');
  }

  #restore() {
    if (this.live) this.stream.write(this.live);
  }

  #stopSpinner() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = null;
  }
}
