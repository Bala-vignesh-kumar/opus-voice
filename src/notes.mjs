// Note mode: capture a discussion, then summarize it.
//
// Nothing is spoken back while capturing — the point is to be a fly on the wall
// during a conversation, not a participant in it.

import fs from 'node:fs';
import path from 'node:path';

export const SUMMARY_PROMPT = `The following is a raw speech-to-text transcript of a discussion
that was captured while you listened. It is unpunctuated in places and contains recognition
errors; read through them.

Start your reply with a single line beginning with "TITLE:" naming the discussion in under
eight words. It becomes the filename, so make it specific to this conversation — "redis lock
for pending records", not "discussion notes".

If the discussion refers to any ticket, issue or pull request, look it up before writing the
summary rather than guessing at what it says. Speech recognition mangles these badly, so treat
spoken forms as references too: "hash four twenty one", "issue 421", "P R four twenty one" and
"proj dash one two three" all point at something. Use \`gh issue view\` or \`gh pr view\` for a
bare number in this repository, and the web for a tracker key or a full URL.

For each reference you resolve, add a "## References" section listing one line per item: the
identifier, its title, and its current state. Use what you learn to make the rest of the
summary concrete — name the actual bug or feature rather than repeating the number. If a
lookup fails, or a reference is too garbled to identify with confidence, say so on its line in
a few words instead of inventing a plausible answer.

Then write a summary with three parts: what was discussed, any decisions that were made, and
any action items with who owns them if that was said. Skip a part entirely if the transcript
has nothing for it. Be concise and concrete.

Do not reproduce the transcript — the summary replaces it.

If the discussion produced action items, list them again at the end, one per line, each on its
own line beginning with "ACTION:" — just the task as an instruction, no owner, no numbering.
These become to-do items, so each one has to stand on its own away from the discussion: "add a
TTL to the redis lock keys", not "do the TTL thing we said".

Finally, at the very end, add a single line beginning with "SPOKEN:" containing a two-sentence
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
   * Writes the summary to `notes/<date>/<title>.md`.
   *
   * A day per folder and a titled file inside it means a week of discussions is
   * browsable without opening anything, which a list of timestamps never is.
   * The transcript is deliberately not written: it is mangled speech that
   * nobody rereads, and the summary is what it was captured for.
   *
   * @returns {string} the file path
   */
  save(dir, summary, title = '') {
    const started = this.startedAt ?? new Date();
    const day = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
    const folder = path.join(dir, 'notes', day);
    fs.mkdirSync(folder, { recursive: true });

    const clean = String(title).trim();
    const stem = slug(clean) || `discussion-${pad(started.getHours())}${pad(started.getMinutes())}`;
    const file = unique(folder, stem);

    const minutes = Math.max(1, Math.round((Date.now() - started.getTime()) / 60000));
    const body = [
      `# ${clean || 'Discussion notes'}`,
      '',
      `${started.toLocaleString()} · ${this.lines.length} utterances over ~${minutes} min.`,
      '',
      summary || '_No summary generated._',
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

/** A filename stem from a spoken title: lowercase words joined by hyphens. */
export function slug(title) {
  return String(title)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * A path that does not exist yet. Two discussions in a day can genuinely be
 * about the same thing, and silently overwriting the earlier one would lose it.
 */
function unique(folder, stem) {
  let candidate = path.join(folder, `${stem}.md`);
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(folder, `${stem}-${n}.md`);
  }
  return candidate;
}

/**
 * Splits the model's reply into its parts: the title, the action items, the
 * written notes and the line meant to be read aloud. Every marker is stripped,
 * so none of this plumbing reaches the file or the speaker.
 */
export function splitSummary(text) {
  const raw = String(text);

  const titleMatch = /^[ \t]*TITLE:[ \t]*(.+)$/im.exec(raw);
  const title = titleMatch ? titleMatch[1].trim() : '';
  let body = titleMatch
    ? raw.slice(0, titleMatch.index) + raw.slice(titleMatch.index + titleMatch[0].length)
    : raw;

  // Action lines are collected and removed. They are repeated on purpose — the
  // prose keeps them in context, and these are the copy that becomes to-dos.
  const actions = [];
  body = body.replace(/^[ \t]*ACTION:[ \t]*(.+)$/gim, (_, item) => {
    const clean = item.trim().replace(/^[-*\d.\s]+/, '').trim();
    if (clean) actions.push(clean);
    return '';
  });

  const spokenMatch = /^[ \t]*SPOKEN:[ \t]*(.+)$/ims.exec(body);
  if (!spokenMatch) return { title, actions, written: body.trim(), spoken: '' };
  return {
    title,
    actions,
    written: body.slice(0, spokenMatch.index).trim(),
    spoken: spokenMatch[1].trim(),
  };
}
