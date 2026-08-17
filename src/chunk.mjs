// Turns a stream of model text into speakable sentences.
//
// Two jobs. First, cut at sentence boundaries as soon as one completes, so
// speech can start while Opus is still generating instead of after it finishes.
// Second, strip anything that is punctuation on a page but noise in the ear —
// markdown, code fences, bullet markers.

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
  'approx', 'inc', 'ltd', 'co', 'fig', 'no', 'al', 'am', 'pm',
]);

// Punctuation, optional closing quote/bracket, then real whitespace. Requiring
// whitespace means a decimal like "3.14" or a mid-stream fragment never cuts.
const BOUNDARY = /[.!?…]["'’”)\]]*\s/g;

/** Strips markdown down to something worth saying out loud. */
export function sanitize(input) {
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, ' ');       // fenced code
  text = text.replace(/`([^`]*)`/g, '$1');           // inline code
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> alt
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');  // links -> label
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');    // headings
  text = text.replace(/^\s*>\s?/gm, '');             // blockquotes
  text = text.replace(/^\s*[-*+]\s+/gm, '');         // bullet markers
  text = text.replace(/^\s*\d+[.)]\s+/gm, '');       // numbered markers
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');   // horizontal rules
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');     // bold
  text = text.replace(/\*([^*]+)\*/g, '$1');         // italics
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2'); // underscore italics
  text = text.replace(/[*_~]/g, '');                 // stragglers
  text = text.replace(/\s+/g, ' ');

  return text.trim();
}

export class SpeechChunker {
  /**
   * @param {object} [options]
   * @param {number} [options.minChars] Sentences shorter than this are merged
   *   with the next one, so the synthesizer isn't handed "Sure." on its own.
   * @param {number} [options.firstMinChars] Threshold for the first sentence of
   *   a reply. Lower, because that one sets the perceived response time — every
   *   millisecond spent merging it is silence the listener is sitting through.
   */
  constructor({ minChars = 24, firstMinChars = 8 } = {}) {
    this.minChars = minChars;
    this.firstMinChars = firstMinChars;
    this.buffer = '';
    this.pending = '';
    this.emitted = 0;
  }

  /** Starts a new reply, so the next sentence gets the fast path again. */
  reset() {
    this.buffer = '';
    this.pending = '';
    this.emitted = 0;
  }

  /** Feeds a delta in, returns any sentences that are now complete. */
  push(delta) {
    this.buffer += delta;
    const ready = [];

    for (;;) {
      const cut = this.#nextBoundary();
      if (cut < 0) break;
      const piece = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      const merged = this.#merge(piece);
      if (merged) ready.push(merged);
    }

    return ready;
  }

  /** Returns whatever is left at end of turn, even if unterminated. */
  flush() {
    const merged = `${this.pending} ${sanitize(this.buffer)}`.trim();
    this.buffer = '';
    this.pending = '';
    if (!merged) return [];
    this.emitted += 1;
    return [merged];
  }

  #merge(piece) {
    const clean = sanitize(piece);
    if (!clean) return null;
    this.pending = this.pending ? `${this.pending} ${clean}` : clean;
    const threshold = this.emitted === 0 ? this.firstMinChars : this.minChars;
    if (this.pending.length < threshold) return null;
    const out = this.pending;
    this.pending = '';
    this.emitted += 1;
    return out;
  }

  #nextBoundary() {
    // Hold everything from an unclosed code fence onward; it isn't speakable
    // and its contents shouldn't be mistaken for sentences.
    const fences = this.buffer.split('```').length - 1;
    const limit = fences % 2 === 1 ? this.buffer.lastIndexOf('```') : this.buffer.length;

    BOUNDARY.lastIndex = 0;
    let match;
    while ((match = BOUNDARY.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      if (end > limit) return -1;
      if (!this.#isAbbreviation(match.index)) return end;
    }
    return -1;
  }

  #isAbbreviation(dotIndex) {
    if (this.buffer[dotIndex] !== '.') return false;
    const before = this.buffer.slice(0, dotIndex);
    const word = /([A-Za-z]+)$/.exec(before);
    if (!word) return false;
    // A single capital is an initial ("J. Smith"), not a sentence end.
    if (word[1].length === 1 && word[1] === word[1].toUpperCase()) return true;
    return ABBREVIATIONS.has(word[1].toLowerCase());
  }
}
