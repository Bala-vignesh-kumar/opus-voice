// Filing a to-do as a GitHub issue.
//
// Shells out to the `gh` CLI rather than talking to the API directly: the auth
// is already there, it respects the repo you are standing in, and there is no
// token for this app to hold.
//
// Creating an issue is public and hard to take back, so nothing here is ever
// called on its own. It runs when you say "make todo two an issue" or click the
// button — the instruction is the confirmation.

import { execFile } from 'node:child_process';

/** Arguments are passed as an array, never a shell string, so a to-do that
 *  contains quotes or backticks is text and not syntax. */
function run(args, cwd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/** Turns gh's failures into something worth saying out loud. */
function explain(err) {
  const text = `${err.stderr || ''} ${err.message || ''}`.toLowerCase();
  if (err.code === 'ENOENT') return 'the GitHub CLI is not installed';
  if (text.includes('not logged') || text.includes('authentication')) {
    return 'the GitHub CLI is not signed in — run gh auth login';
  }
  if (text.includes('not a git repository') || text.includes('no git remote') || text.includes('could not determine')) {
    return 'this folder is not a GitHub repository';
  }
  if (err.killed) return 'GitHub timed out';
  const first = (err.stderr || '').split('\n').find(Boolean);
  return first ? first.trim() : 'the GitHub CLI failed';
}

/**
 * Creates an issue in the repository at `cwd`.
 *
 * @returns {Promise<{number: number, url: string}>}
 * @throws {Error} with a message fit to be spoken
 */
export async function createIssue({ title, body = '', cwd }) {
  const clean = String(title).trim();
  if (!clean) throw new Error('there is nothing to file');

  let out;
  try {
    out = await run(['issue', 'create', '--title', clean, '--body', body], cwd);
  } catch (err) {
    throw new Error(explain(err));
  }

  // gh prints the new issue's URL on the last line.
  const url = (out.split('\n').filter(Boolean).pop() || '').trim();
  const match = /\/issues\/(\d+)\s*$/.exec(url);
  if (!match) throw new Error('the issue was created but GitHub did not say where');
  return { number: Number(match[1]), url };
}

/** Whether filing is possible here, so the window can disable the button. */
export async function available(cwd) {
  try {
    await run(['repo', 'view', '--json', 'name'], cwd, 10000);
    return true;
  } catch {
    return false;
  }
}
