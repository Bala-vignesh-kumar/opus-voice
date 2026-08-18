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
const todosEl = document.getElementById('todos');
const todoList = document.getElementById('todo-list');
const todoCount = document.getElementById('todo-count');
const todoInput = document.getElementById('todo-input');
const todoToggle = document.getElementById('todo-toggle');

const nodes = new Map();   // entry id -> its element
let mode = 'asleep';
let status = null;
let speaking = false;
let todos = [];
let phrase = 'hey falcon';
let hint = '"hey falcon"';
let showDone = false;

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
  else if (mode === 'note') { kind = 'notes'; label = `listening — say "${phrase} stop" to finish`; }
  else if (mode === 'chat' || mode === 'awake') { kind = 'listening'; label = 'listening'; }
  else { label = `asleep — say ${hint} to wake`; }

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
      todos = patch.todos ?? [];
      paintTodos();
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
    case 'todos': todos = patch.todos; paintTodos(); break;
    default: break;
  }
}

// ---------------------------------------------------------------- to-dos

/** A row button. Kept small because every row has three of them. */
function action(label, title, onClick) {
  const button = document.createElement('button');
  button.className = 'ghost';
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function paintTodos() {
  const open = todos.filter((t) => !t.done);
  const shown = showDone ? todos : open;

  // An empty list with nothing ever added is clutter; once it has been used the
  // panel stays, so a list you just emptied does not vanish out from under you.
  todosEl.hidden = todos.length === 0;
  todoCount.textContent = open.length ? `${open.length} open` : 'all done';
  todoToggle.textContent = showDone ? 'hide done' : 'show done';
  todoToggle.hidden = todos.length === open.length;

  todoList.replaceChildren();
  if (shown.length === 0) {
    const li = document.createElement('li');
    li.className = 'todos-empty';
    li.textContent = 'Nothing open.';
    todoList.appendChild(li);
    return;
  }

  for (const item of shown) {
    const li = document.createElement('li');
    li.className = `todo${item.done ? ' done' : ''}`;

    const ord = document.createElement('span');
    ord.className = 'ord';
    // Only open items have a number, because that is what the ordinals count.
    ord.textContent = item.done ? '✓' : `${item.ordinal}.`;
    li.appendChild(ord);

    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = item.text;
    if (item.issue) {
      const link = document.createElement('a');
      link.className = 'issue';
      link.href = item.issue.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = `#${item.issue.number}`;
      what.appendChild(link);
    }
    li.appendChild(what);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (item.done) {
      actions.appendChild(action('↩', 'reopen', () => send({ cmd: 'todo', action: 'reopen', id: item.id })));
    } else {
      actions.appendChild(action('✓', 'mark done', () => send({ cmd: 'todo', action: 'done', id: item.id })));
      const issue = action('⇧', 'file as a GitHub issue', () => {
        // Public and awkward to withdraw, so the click is confirmed once here
        // rather than filed the instant the pointer lands on it.
        if (confirm(`File a GitHub issue for:\n\n${item.text}`)) {
          send({ cmd: 'todo', action: 'issue', id: item.id });
        }
      });
      issue.disabled = Boolean(item.issue);
      actions.appendChild(issue);
    }
    actions.appendChild(action('✕', 'remove', () => send({ cmd: 'todo', action: 'remove', id: item.id })));
    li.appendChild(actions);

    todoList.appendChild(li);
  }
}

function info({ model, engine, locale, onDevice, workdir, wakePhrase, wakeHint }) {
  if (wakePhrase) phrase = wakePhrase;
  if (wakeHint) {
    hint = wakeHint;
    const empty = document.querySelector('.empty p');
    if (empty) {
      empty.textContent = '';
      const b = document.createElement('b');
      b.textContent = wakeHint.replace(/"/g, '');
      empty.append('Say ', b, ' to wake it.');
    }
  }
  if (wakePhrase || wakeHint) paintState();
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

document.getElementById('todo-composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = todoInput.value.trim();
  if (!text) return;
  todoInput.value = '';
  send({ cmd: 'todo', action: 'add', text });
});

todoToggle.addEventListener('click', () => {
  showDone = !showDone;
  paintTodos();
});

// Escape cuts it off mid-sentence, the way talking over it does.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') send({ cmd: 'interrupt' });
});

paintState();
paintTodos();
connect();
input.focus();
