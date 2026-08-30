// The window. Renders what the orchestrator sends and sends back what you click.
//
// No conversation logic lives here on purpose: this file draws state and posts
// commands, and everything that decides anything is in src/.
//
// Two kinds of thing arrive by two routes. The live conversation is pushed down
// the event stream, because it changes while you watch it. The library — past
// conversations, notes — is fetched when you ask for it, because it is history
// and does not.

const token = new URLSearchParams(location.search).get('k') ?? '';

const linkDot = document.getElementById('link-dot');
const stateEl = document.getElementById('state');
const stateLabel = document.getElementById('state-label');
const sayEl = document.getElementById('say');
const hintEl = document.getElementById('hint');
const stage = document.getElementById('stage');
const input = document.getElementById('input');
const meetingsEl = document.getElementById('meetings');
const todosEl = document.getElementById('todos');
const todoList = document.getElementById('todo-list');
const todoCount = document.getElementById('todo-count');
const todoInput = document.getElementById('todo-input');
const todoToggle = document.getElementById('todo-toggle');
const browseEl = document.getElementById('browse');
const browseTitle = document.getElementById('browse-title');
const browseCount = document.getElementById('browse-count');
const browseSearch = document.getElementById('browse-search');
const browseList = document.getElementById('browse-list');
const browseRead = document.getElementById('browse-read');
const canvas = document.getElementById('field');
const halo = document.getElementById('halo');

let entries = [];
let mode = 'asleep';
let status = null;
let speaking = false;
let partial = '';
let todos = [];
let phrase = 'hey falcon';
let hint = '"hey falcon"';
let showDone = false;
let level = { in: 0, out: 0 };

let view = 'library';
let items = [];
let selected = null;
let filter = '';

// ------------------------------------------------------------------- state

/** Which of the five looks the form is wearing. Everything keys off this. */
function kind() {
  if (speaking) return 'speaking';
  if (status) return 'thinking';
  if (mode === 'note') return 'notes';
  if (mode === 'chat' || mode === 'awake') return 'listening';
  return 'idle';
}

function lastOf(role) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === role) return entries[i];
  }
  return null;
}

/**
 * The live view shows the exchange, not the log: the sentence being spoken (or
 * heard) at reading size and nothing else. The whole transcript is in Chats,
 * which is where you go when you want to read rather than glance.
 */
function paint() {
  const k = kind();

  if (k === 'idle') delete stateEl.dataset.kind;
  else stateEl.dataset.kind = k;

  let label = 'asleep';
  if (k === 'speaking') label = 'speaking';
  else if (k === 'thinking') label = status;
  else if (k === 'notes') label = 'taking notes';
  else if (k === 'listening') label = 'listening';
  stateLabel.textContent = label;

  const answer = lastOf('opus');
  sayEl.classList.toggle('partial', Boolean(partial));
  sayEl.classList.toggle('cut', !partial && Boolean(answer?.interrupted));

  if (partial) sayEl.textContent = partial;
  else if (answer) sayEl.textContent = answer.text;
  else sayEl.textContent = '';

  hintEl.replaceChildren(...hintFor(k));
  paintHalo(k);
}

/** Built as nodes rather than innerHTML: the wake phrase comes from config. */
function hintFor(k) {
  if (k === 'notes') {
    const b = document.createElement('b');
    b.textContent = `${phrase} stop`;
    return [document.createTextNode('Say '), b, document.createTextNode(' to finish and write the notes.')];
  }
  if (k === 'speaking') return [document.createTextNode('Just start talking to cut it off.')];
  if (k === 'thinking') return [];
  if (k === 'listening') return [document.createTextNode('Listening — just talk.')];
  const b = document.createElement('b');
  b.textContent = hint.replace(/"/g, '');
  return [document.createTextNode('Say '), b, document.createTextNode(' to wake it.')];
}

function apply(patch) {
  switch (patch.type) {
    case 'snapshot':
      entries = patch.entries ?? [];
      mode = patch.mode;
      status = patch.status;
      speaking = patch.speaking;
      partial = patch.partial ?? '';
      level = patch.level ?? { in: 0, out: 0 };
      if (patch.info?.model) info(patch.info);
      todos = patch.todos ?? [];
      paintTodos();
      paint();
      break;
    case 'entry': entries.push(patch.entry); paint(); break;
    case 'append': {
      const entry = entries.find((e) => e.id === patch.id);
      if (entry) entry.text = `${entry.text} ${patch.text}`.trim();
      paint();
      break;
    }
    case 'interrupted': {
      const entry = entries.find((e) => e.id === patch.id);
      if (entry) entry.interrupted = true;
      paint();
      break;
    }
    case 'partial': partial = patch.text; paint(); break;
    case 'mode':
      mode = patch.mode;
      paint();
      // Going to sleep closes a conversation on disk, so a Chats list that is
      // open at that moment is now one conversation out of date.
      if (patch.mode === 'asleep' && view !== 'library') load();
      break;
    case 'status': status = patch.status; paint(); break;
    case 'speaking': speaking = patch.speaking; paint(); break;
    // Thirty of these a second, and none of them touch the DOM: the field reads
    // the value on its own frame instead. Repainting the page at audio rate is
    // exactly what makes an ambient screen feel expensive.
    case 'level': level = { ...level, [patch.source]: patch.rms }; break;
    case 'info': info(patch.info); break;
    case 'todos': todos = patch.todos; paintTodos(); break;
    default: break;
  }
}

function info({ wakePhrase, wakeHint }) {
  if (wakePhrase) phrase = wakePhrase;
  if (wakeHint) hint = wakeHint;
  if (wakePhrase || wakeHint) paint();
}

// -------------------------------------------------------------------- views

const VIEWS = ['library', 'today', 'chats', 'notes'];

function setView(next) {
  if (!VIEWS.includes(next)) next = 'library';
  view = next;
  document.body.dataset.view = next;
  // In the hash so the window comes back where you left it. A window that is
  // reopened from the menu bar all day should not always land on the same page.
  const hash = next === 'library' ? '' : `#${next}`;
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  document.querySelectorAll('.nav .t').forEach((b) => b.classList.toggle('on', b.dataset.view === next));

  const live = next === 'library';
  meetingsEl.hidden = !live;
  stage.hidden = !live;
  browseEl.hidden = live;
  paintTodos();

  if (!live) {
    selected = null;
    filter = '';
    browseSearch.value = '';
    browseTitle.textContent = next === 'chats' ? 'Chats' : next === 'notes' ? 'Notes' : 'Today';
    load();
  }
}

async function api(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-opus-token': token } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Loads whichever list the current view is showing, newest first. */
async function load() {
  const want = view;
  items = [];
  browseList.replaceChildren(loading());
  browseRead.replaceChildren();

  try {
    const [chats, notes] = await Promise.all([
      want === 'notes' ? [] : api('/library/chats'),
      want === 'chats' ? [] : api('/library/notes'),
    ]);
    // The view may have changed while those were in flight.
    if (want !== view) return;

    const asChat = (c) => ({
      kind: 'chat',
      id: c.id,
      day: c.day,
      mode: c.mode,
      title: c.title,
      sub: c.preview,
      at: c.started,
      turns: c.turns,
    });
    const asNote = (n) => ({
      kind: 'note',
      id: n.id,
      day: n.day,
      mode: 'note',
      title: n.title,
      sub: n.meta,
      at: n.at,
    });

    items = [...chats.map(asChat), ...notes.map(asNote)];
    if (want === 'today') items = items.filter((i) => i.day === today());
    items.sort((a, b) => String(b.day).localeCompare(String(a.day)) || stampOf(b) - stampOf(a));
  } catch {
    items = [];
  }

  paintList();
  if (items.length) select(items[0]);
  else browseRead.replaceChildren(empty(emptyFor(view)));
}

function stampOf(item) {
  const t = typeof item.at === 'number' ? item.at : Date.parse(item.at);
  return Number.isFinite(t) ? t : 0;
}

function emptyFor(v) {
  if (v === 'notes') {
    return 'No notes yet. Say "hey falcon listen" to capture a discussion, then "hey falcon stop" — it writes one file per discussion under notes/.';
  }
  if (v === 'today') return 'Nothing yet today.';
  return 'No conversations yet. Everything you say to it from now on is kept here, one file per conversation, from waking it to sending it back to sleep.';
}

function loading() {
  const div = document.createElement('div');
  div.className = 'list-empty';
  div.textContent = 'Loading…';
  return div;
}

function empty(text) {
  const div = document.createElement('div');
  div.className = 'read-empty';
  div.textContent = text;
  return div;
}

function dayLabel(day) {
  if (day === today()) return 'Today';
  const d = new Date(`${day}T00:00:00`);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeLabel(item) {
  const t = stampOf(item);
  if (!t) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function paintList() {
  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.filter((i) => `${i.title} ${i.sub}`.toLowerCase().includes(q))
    : items;

  browseCount.textContent = shown.length
    ? `${shown.length}${q ? ' found' : ''}`
    : '';

  browseList.replaceChildren();
  if (shown.length === 0) {
    const div = document.createElement('div');
    div.className = 'list-empty';
    div.textContent = q ? 'Nothing matches.' : emptyFor(view);
    browseList.appendChild(div);
    return;
  }

  // Grouped by day, because "when" is how you actually look for a conversation
  // you half remember.
  let day = null;
  for (const item of shown) {
    if (item.day !== day) {
      day = item.day;
      const head = document.createElement('div');
      head.className = 'day';
      head.textContent = dayLabel(day);
      browseList.appendChild(head);
    }

    const row = document.createElement('div');
    row.className = `item${selected?.id === item.id && selected?.kind === item.kind ? ' on' : ''}`;
    row.dataset.mode = item.mode ?? 'chat';

    const top = document.createElement('div');
    top.className = 'top';
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = item.title;
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = timeLabel(item);
    top.append(ttl, at);
    row.appendChild(top);

    if (item.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = item.sub;
      row.appendChild(sub);
    }

    row.addEventListener('click', () => select(item));
    browseList.appendChild(row);
  }
}

async function select(item) {
  selected = item;
  paintList();
  browseRead.replaceChildren(loading());
  try {
    const full = item.kind === 'note'
      ? await api('/library/note', { id: item.id })
      : await api('/library/chat', { id: item.id });
    if (selected !== item) return;
    browseRead.replaceChildren(...(item.kind === 'note' ? readNote(item, full) : readChat(item, full)));
  } catch {
    browseRead.replaceChildren(empty('That one could not be read.'));
  }
}

function head(title, meta) {
  const h = document.createElement('h1');
  h.className = 'read-title';
  h.textContent = title;
  const m = document.createElement('div');
  m.className = 'read-meta';
  m.textContent = meta;
  return [h, m];
}

function readChat(item, record) {
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const started = Date.parse(record.started);
  const ended = Date.parse(record.ended ?? record.started);
  const minutes = Math.max(1, Math.round((ended - started) / 60000));
  const meta = [
    timeLabel(item),
    `${minutes} min`,
    `${turns.length} turn${turns.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  const out = head(record.title || item.title, meta);
  for (const turn of turns) {
    const el = document.createElement('div');
    el.className = `turn ${turn.role}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = turn.role;
    const tx = document.createElement('div');
    tx.className = 'tx';
    tx.textContent = turn.text;
    el.append(who, tx);
    out.push(el);
  }
  return out;
}

function readNote(item, record) {
  const lines = String(record.body ?? '').split('\n');
  // The file leads with its own heading and a meta line, both of which this
  // pane is already showing; printing them again reads as a stutter.
  const title = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : item.title;
  const meta = lines[2]?.trim() ?? '';
  const body = lines.slice(lines[0]?.startsWith('# ') ? 3 : 0).join('\n').trim();

  const out = head(title, meta);
  const pre = document.createElement('div');
  pre.className = 'note-body';
  pre.textContent = body;
  out.push(pre);
  return out;
}

// ------------------------------------------------------------------ to-dos

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
  // rail stays, so a list you just emptied does not vanish out from under you.
  todosEl.hidden = view !== 'library' || todos.length === 0;
  todoCount.textContent = open.length ? `${open.length} open` : 'all done';
  todoToggle.textContent = showDone ? 'hide done' : 'show done';
  todoToggle.hidden = todos.length === open.length;

  todoList.replaceChildren();
  if (shown.length === 0) {
    const div = document.createElement('div');
    div.className = 'list-empty';
    div.textContent = 'Nothing open.';
    todoList.appendChild(div);
    return;
  }

  for (const item of shown) {
    const row = document.createElement('div');
    row.className = `todo${item.done ? ' done' : ''}`;

    const ord = document.createElement('span');
    ord.className = 'ord';
    // Only open items have a number, because that is what the ordinals count.
    ord.textContent = item.done ? '✓' : `${item.ordinal}.`;
    row.appendChild(ord);

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
    row.appendChild(what);

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
    row.appendChild(actions);

    todoList.appendChild(row);
  }
}

// ------------------------------------------------------------------- field

// The same arrangement as the design: 130 points on a golden-angle spiral in a
// band, seeded so it is identical every launch. A field that re-scatters on
// every start reads as a different app each morning.
const COUNT = 130;
const VIEW = 260;
const CENTRE = VIEW / 2;

const COLOURS = {
  idle: [93, 99, 110],
  listening: [143, 217, 168],
  thinking: [224, 180, 115],
  speaking: [127, 179, 255],
  notes: [224, 180, 115],
};

// Rotation in radians per second, how fast a point breathes, and how far the
// band is thrown outward at full volume. Asleep barely turns; thinking is tight
// and quick because nothing is being heard and the motion has to read as work.
const MOTION = {
  idle: { spin: 0.02, flick: 1.3, spread: 0.10 },
  listening: { spin: 0.18, flick: 2.8, spread: 0.62 },
  thinking: { spin: 0.45, flick: 3.9, spread: 0.22 },
  speaking: { spin: 0.24, flick: 5.7, spread: 0.50 },
  notes: { spin: 0.012, flick: 0.9, spread: 0.14 },
};

const dots = (() => {
  let s = 20260830;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out = [];
  for (let i = 0; i < COUNT; i += 1) {
    out.push({
      angle: i * 2.39996,
      band: 48 + rnd() * 40,
      r: 0.6 + rnd() * 1.7,
      alpha: 0.14 + rnd() * 0.52,
      phase: rnd() * Math.PI * 2,
    });
  }
  return out;
})();

const ctx = canvas.getContext('2d');
let rot = 0;
let energy = 0;
// Loudness is relative to the microphone and the room, and both vary by an
// order of magnitude between machines. A decaying peak turns any input into a
// usable 0..1 without anyone having to calibrate a gain.
let peak = 0.02;

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth || 340;
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale((css * dpr) / VIEW, (css * dpr) / VIEW);
}

function paintHalo(k) {
  const [r, g, b] = COLOURS[k];
  halo.style.background =
    `radial-gradient(closest-side, rgba(${r},${g},${b},0.17), rgba(${r},${g},${b},0.05) 62%, transparent 76%)`;
}

function draw(now) {
  const k = kind();
  const motion = MOTION[k];
  const [r, g, b] = COLOURS[k];

  // Its own voice while it is talking, the room's while it is not.
  const raw = k === 'speaking' ? level.out : level.in;
  peak = Math.max(peak * 0.995, raw, 0.02);
  const target = k === 'idle' || k === 'notes' ? 0.12 : Math.min(raw / peak, 1);
  // Fast up, slow down: a voice starts abruptly and the form should catch it,
  // but snapping back on every syllable gap looks like a fault.
  energy += (target - energy) * (target > energy ? 0.35 : 0.06);

  rot += motion.spin / 60;
  const t = now / 1000;

  ctx.clearRect(0, 0, VIEW, VIEW);

  const spread = 1 + energy * motion.spread;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  for (const d of dots) {
    const a = d.angle + rot;
    const band = d.band * spread;
    const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * motion.flick + d.phase));
    ctx.globalAlpha = d.alpha * pulse;
    ctx.beginPath();
    ctx.arc(CENTRE + Math.cos(a) * band, CENTRE + Math.sin(a) * band, d.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A soft centre, not a disc. A flat circle at even alpha reads as a solid
  // object sitting in front of the field rather than as the middle of it.
  const glow = ctx.createRadialGradient(CENTRE, CENTRE, 0, CENTRE, CENTRE, 40);
  glow.addColorStop(0, `rgba(${r},${g},${b},${(0.055 + energy * 0.07).toFixed(3)})`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(CENTRE, CENTRE, 40, 0, Math.PI * 2);
  ctx.fill();

  halo.style.opacity = (0.7 + energy * 0.3).toFixed(2);
}

let frame = null;

function loop(now) {
  draw(now);
  frame = requestAnimationFrame(loop);
}

function startField() {
  sizeCanvas();
  paintHalo(kind());
  // A field that moves all day is the wrong thing to force on someone who has
  // asked the system for less motion; it still shows state, it just holds still.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    draw(0);
    return;
  }
  if (frame === null) frame = requestAnimationFrame(loop);
}

function stopField() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
}

// Nothing to animate for a window nobody is looking at, and a hidden tab still
// gets its callbacks on some macOS builds.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopField();
  else startField();
});

window.addEventListener('resize', sizeCanvas);

// --------------------------------------------------------------- transport

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

// ------------------------------------------------------------------- input

document.querySelectorAll('.nav .t').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

document.querySelectorAll('button[data-cmd]').forEach((button) => {
  button.addEventListener('click', () => {
    send({ cmd: 'mode', mode: button.dataset.cmd });
    // Talking to it means you want to watch it, not read last week.
    if (view !== 'library') setView('library');
  });
});

document.getElementById('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ cmd: 'say', text });
  if (view !== 'library') setView('library');
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

browseSearch.addEventListener('input', () => {
  filter = browseSearch.value;
  paintList();
});

document.addEventListener('keydown', (event) => {
  // Escape backs out of a library view, and otherwise cuts it off mid-sentence
  // the way talking over it does.
  if (event.key !== 'Escape') return;
  if (view !== 'library') setView('library');
  else send({ cmd: 'interrupt' });
});

paint();
setView(location.hash.slice(1) || 'library');
startField();
connect();
if (view === 'library') input.focus();
