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

// Every transcript line is indented past a label of this width, so answers form
// one straight column no matter who is speaking.
const GUTTER = 6;
const MIN_WIDTH = 40;
const MAX_WIDTH = 100;

/**
 * Wraps at word boundaries to the given width. Spoken answers are prose and
 * frequently longer than the window; letting the terminal hard-wrap them breaks
 * words mid-syllable and destroys the column the gutter exists to create.
 */
function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

export class Ui {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.live = '';
    this.frame = 0;
    this.timer = null;
    this.status = null;
    this.lastSpeaker = null;
    this.printed = false;   // has any transcript line been written yet
  }

  /** Usable text width, leaving the gutter and a right margin. */
  get #width() {
    const columns = this.stream.columns || 80;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, columns) - GUTTER - 2);
  }

  /**
   * Prints a labelled, wrapped block. Continuation lines sit under the text
   * rather than under the label, and a blank line separates a change of
   * speaker so a long exchange does not read as one wall of text.
   */
  #say(label, text, { speaker = label, colour = '', dim = false } = {}) {
    const body = wrap(text, this.#width);
    const pad = ' '.repeat(GUTTER);
    // Labels are right-aligned in the gutter so "you", "opus" and the one-glyph
    // markers all end at the same column and the text starts at the same one.
    // The label must arrive uncoloured or its escape codes break this padding.
    const head = label
      ? `${' '.repeat(GUTTER - 2 - label.length)}${colour}${label}${C.reset}  `
      : pad;
    if (speaker && this.lastSpeaker && speaker !== this.lastSpeaker) this.print('');
    this.lastSpeaker = speaker;
    const open = dim ? C.grey : '';
    const close = dim ? C.reset : '';
    this.print(body.map((line, i) => `${i === 0 ? head : pad}${open}${line}${close}`).join('\n'));
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
    this.printed = true;
    this.#clear();
    this.stream.write(`${text}\n`);
    this.#restore();
  }

  you(text) { this.#say('you', text, { colour: C.blue }); }

  /** Prints a sentence as it is handed to the synthesizer; label only leads. */
  opus(text, first) {
    this.#say(first ? 'opus' : '', text, { speaker: 'opus', colour: C.green });
  }

  note(text) { this.#say('', text, { speaker: 'note', dim: true }); }

  /** Speech captured in note mode. */
  heard(text) { this.#say('·', text, { speaker: 'heard', colour: C.grey, dim: true }); }

  /** Speech ignored because it's asleep — shown so it doesn't look broken. */
  ignored(text) {
    const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    this.#say('⌁', short, { speaker: 'ignored', colour: C.grey, dim: true });
  }

  /** Announces a mode change and parks it on the live line. */
  mode(name) {
    const labels = {
      asleep: `${C.grey}asleep — say "falcon" to wake${C.reset}`,
      awake: `${C.green}awake${C.reset}`,
      chat: `${C.green}chat${C.reset}`,
      note: `${C.amber}taking notes${C.reset} ${C.grey}— say "falcon stop" to finish${C.reset}`,
    };
    // A mode change is a scene break, so it gets air above it — except as the
    // very first line, where the banner has already left a gap.
    if (this.printed) this.print('');
    this.lastSpeaker = 'mode';
    this.print(`${' '.repeat(GUTTER - 2)}${C.grey}›${C.reset} ${labels[name] ?? name}`);
  }

  warn(text) { this.#say('!', text, { speaker: 'warn', colour: C.amber, dim: true }); }
  error(text) { this.#say('✗', text, { speaker: 'error', colour: C.red }); }

  /** Interim transcript while the user is still talking. */
  hearing(text) {
    this.#stopSpinner();
    this.#setLive(`${' '.repeat(GUTTER - 5)}${C.grey}···  ${text}${C.reset}`);
  }

  /** Animated status such as "thinking". */
  spin(label) {
    if (this.status === label) return;
    this.status = label;
    this.#stopSpinner();
    const render = () => {
      const glyph = SPINNER[this.frame++ % SPINNER.length];
      this.#setLive(`${' '.repeat(GUTTER - 3)}${C.grey}${glyph}  ${label}${C.reset}`);
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
