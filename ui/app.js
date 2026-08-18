// The window. Renders what the orchestrator sends and sends back what you click.
//
// No conversation logic lives here on purpose: this file draws state and posts
// commands, and everything that decides anything is in src/.

const token = new URLSearchParams(location.search).get('k') ?? '';

const stream = document.getElementById('stream');
const empty = document.getElementById('empty');
const live = document.getElementById('live');
const modeEl = document.getElementById('mode');
const metaEl = document.getElementById('meta');
const orb = document.getElementById('orb');
const stateLabel = document.getElementById('state-label');
const linkDot = document.getElementById('link-dot');
const input = document.getElementById('input');

const nodes = new Map();   // entry id -> its element
let mode = 'asleep';
let status = null;
let speaking = false;

// ---------------------------------------------------------------- rendering

const LABELS = { you: 'you', opus: 'opus', tool: '', heard: '', ignored: '', system: '', warn: '', error: '' };

function atBottom() {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
}

function render(entry) {
  const pinned = atBottom();
  const el = document.createElement('div');
  el.className = `turn ${entry.role}`;
  if (entry.interrupted) el.classList.add('cut');

  const label = LABELS[entry.role];
  if (label) {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = label;
    el.appendChild(who);
  }

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = entry.text;
  el.appendChild(text);

  stream.appendChild(el);
  nodes.set(entry.id, el);
  empty.hidden = true;
  // Only follow the conversation if the user hasn't scrolled up to read.
  if (pinned) stream.scrollTop = stream.scrollHeight;
}

function append(id, text) {
  const el = nodes.get(id);
  if (!el) return;
  const pinned = atBottom();
  const body = el.querySelector('.text');
  body.textContent = `${body.textContent} ${text}`.trim();
  if (pinned) stream.scrollTop = stream.scrollHeight;
}

function paintState() {
  modeEl.textContent = mode === 'note' ? 'taking notes' : mode;
  modeEl.dataset.mode = mode;

  let kind = 'idle';
  let label = mode;

  if (speaking) { kind = 'speaking'; label = 'speaking'; }
  else if (status) { kind = 'thinking'; label = status; }
  else if (mode === 'note') { kind = 'notes'; label = 'listening — say "jarvis stop" to finish'; }
  else if (mode === 'chat' || mode === 'awake') { kind = 'listening'; label = 'listening'; }
  else { label = 'asleep — say "jarvis" to wake'; }

  orb.className = `orb ${kind}`;
  document.querySelector('.empty .orb').className = `orb ${kind}`;
  stateLabel.textContent = label;
}

function apply(patch) {
  switch (patch.type) {
    case 'snapshot':
      stream.querySelectorAll('.turn').forEach((n) => n.remove());
      nodes.clear();
      patch.entries.forEach(render);
      empty.hidden = patch.entries.length > 0;
      mode = patch.mode;
      status = patch.status;
      speaking = patch.speaking;
      if (patch.info?.model) info(patch.info);
      live.hidden = !patch.partial;
      live.textContent = patch.partial;
      paintState();
      break;
    case 'entry': render(patch.entry); break;
    case 'append': append(patch.id, patch.text); break;
    case 'interrupted': nodes.get(patch.id)?.classList.add('cut'); break;
    case 'partial':
      live.textContent = patch.text;
      live.hidden = !patch.text;
      break;
    case 'mode': mode = patch.mode; paintState(); break;
    case 'status': status = patch.status; paintState(); break;
    case 'speaking': speaking = patch.speaking; paintState(); break;
    case 'info': info(patch.info); break;
    default: break;
  }
}

function info({ model, engine, locale, onDevice, workdir }) {
  const bits = [model, engine, `${onDevice ? 'on-device' : 'server'} ${locale}`, workdir];
  metaEl.textContent = bits.filter(Boolean).join('  ·  ');
  metaEl.title = workdir ?? '';
}

// ---------------------------------------------------------------- transport

function connect() {
  const source = new EventSource(`/events?k=${encodeURIComponent(token)}`);

  source.onopen = () => linkDot.classList.add('on');
  source.onmessage = (event) => {
    try {
      apply(JSON.parse(event.data));
    } catch {
      /* a malformed frame should not take the window down */
    }
  };
  // EventSource reconnects on its own; the next snapshot re-syncs everything,
  // so a dropped connection costs nothing but the dot going dark.
  source.onerror = () => linkDot.classList.remove('on');
}

function send(command) {
  fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opus-token': token },
    body: JSON.stringify(command),
  }).catch(() => {});
}

// ---------------------------------------------------------------- input

document.querySelectorAll('button[data-cmd]').forEach((button) => {
  button.addEventListener('click', () => send({ cmd: 'mode', mode: button.dataset.cmd }));
});

document.getElementById('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ cmd: 'say', text });
});

// Escape cuts it off mid-sentence, the way talking over it does.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') send({ cmd: 'interrupt' });
});

paintState();
connect();
input.focus();
