// Note mode: capture a discussion, then summarize it.
//
// Nothing is spoken back while capturing — the point is to be a fly on the wall
// during a conversation, not a participant in it.

import fs from 'node:fs';
import path from 'node:path';

export const SUMMARY_PROMPT = `The following is a raw speech-to-text transcript of a discussion
that was captured while you listened. It is unpunctuated in places and contains recognition
errors; read through them.

Write a summary with three parts: what was discussed, any decisions that were made, and any
action items with who owns them if that was said. Skip a part entirely if the transcript has
nothing for it. Be concise and concrete.

Then, at the very end, add a single line beginning with "SPOKEN:" containing a two-sentence
spoken summary suitable for reading aloud.

Transcript:
`;

export class Notes {
  constructor() {
    this.lines = [];
    this.startedAt = null;
  }

  get active() {
    return this.startedAt !== null;
  }

  get count() {
    return this.lines.length;
  }

  start() {
    this.lines = [];
    this.startedAt = new Date();
  }

  add(text) {
    const clean = text.trim();
    if (clean) this.lines.push({ at: new Date(), text: clean });
  }

  transcript() {
    return this.lines.map((line) => line.text).join('\n');
  }

  /**
   * Writes transcript and summary to a dated markdown file.
   * @returns {string} the file path
   */
  save(dir, summary) {
    const started = this.startedAt ?? new Date();
    const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}-${pad(started.getHours())}${pad(started.getMinutes())}`;
    const folder = path.join(dir, 'notes');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${stamp}.md`);

    const minutes = Math.max(1, Math.round((Date.now() - started.getTime()) / 60000));
    const body = [
      `# Discussion notes — ${started.toLocaleString()}`,
      '',
      `${this.lines.length} utterances over ~${minutes} min.`,
      '',
      '## Summary',
      '',
      summary || '_No summary generated._',
      '',
      '## Transcript',
      '',
      ...this.lines.map((line) => `- ${line.text}`),
      '',
    ].join('\n');

    fs.writeFileSync(file, body, 'utf8');
    this.startedAt = null;
    return file;
  }

  discard() {
    this.lines = [];
    this.startedAt = null;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Splits the model's summary into the written part and the spoken one. */
export function splitSummary(text) {
  const match = /^SPOKEN:\s*(.+)$/ims.exec(text);
  if (!match) return { written: text.trim(), spoken: '' };
  return {
    written: text.slice(0, match.index).trim(),
    spoken: match[1].trim(),
  };
}
