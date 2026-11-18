'use strict';

const TZ = 'Asia/Bangkok';
const STATUS_LABEL = { todo: 'To do', doing: 'Doing', done: 'Done' };
const ORDER = ['todo', 'doing', 'done'];
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOON_DAYS = 2;

const $ = (sel) => document.querySelector(sel);
const dtFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDateTime = (iso) => dtFmt.format(new Date(iso));
const fmtDate = (ymd) => dateFmt.format(new Date(ymd + 'T00:00:00Z'));
const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

function dueState(task) {
  if (!task.due_date || task.status === 'done') return null;
  const days = (Date.parse(task.due_date) - Date.parse(todayYmd())) / 86400000;
  if (days < 0) return 'overdue';
  if (days <= SOON_DAYS) return 'soon';
  return null;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

// ---------- state ----------
let boardTasks = [];
let view = 'board';
let currentTaskId = null; // task open in dialog (null = creating)

// ---------- cards ----------
function renderCard(task) {
  const state = dueState(task);
  const card = el('div', {
    class: `card p-${task.priority}` + (state === 'overdue' ? ' overdue-card' : state === 'soon' ? ' soon-card' : ''),
    draggable: 'true',
    'data-id': task.id,
  });
  card.append(el('div', { class: 'title', text: task.title }));

  const meta = el('div', { class: 'meta' });
  meta.append(el('span', { text: task.priority[0].toUpperCase() + task.priority.slice(1) }));
  if (task.due_date) {
    const label = state === 'overdue' ? `Overdue · ${fmtDate(task.due_date)}` : `Due ${fmtDate(task.due_date)}`;
    meta.append(el('span', { class: 'badge' + (state ? ` ${state === 'overdue' ? 'overdue' : 'soon'}` : ''), text: label }));
  }
  card.append(meta);

  if (task.last_update) {
    card.append(el('div', { class: 'last', text: `${fmtDateTime(task.last_update_at)} — ${task.last_update}` }));
  }

  // Move buttons (touch screens cannot drag-and-drop)
  const idx = ORDER.indexOf(task.status);
  const move = el('div', { class: 'move' });
  if (idx > 0) move.append(el('button', { text: `← ${STATUS_LABEL[ORDER[idx - 1]]}`, onclick: (e) => { e.stopPropagation(); moveTask(task.id, ORDER[idx - 1]); } }));
  if (idx < 2) move.append(el('button', { text: `${STATUS_LABEL[ORDER[idx + 1]]} →`, onclick: (e) => { e.stopPropagation(); moveTask(task.id, ORDER[idx + 1]); } }));
  card.append(move);

  card.addEventListener('click', () => openTask(task.id));
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

function renderBoard() {
  const overdueOnly = $('#overdue-only').checked;
  for (const status of ORDER) {
    const col = document.querySelector(`.column[data-status="${status}"]`);
    const list = col.querySelector('.cards');
    list.replaceChildren();
    let n = 0;
    for (const t of boardTasks) {
      if (t.status !== status) continue;
      if (overdueOnly && dueState(t) !== 'overdue') continue;
      list.append(renderCard(t));
      n++;
    }
    col.querySelector('.count').textContent = n;
  }
}

async function loadBoard() {
  boardTasks = await api('GET', '/api/tasks');
  renderBoard();
}

async function moveTask(id, status) {
  try {
    await api('PATCH', `/api/tasks/${id}`, { status });
    await loadBoard();
  } catch (e) {
    alert(e.message);
  }
}

// drag & drop targets
for (const col of document.querySelectorAll('.column')) {
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('drag-over');
    const id = Number(e.dataTransfer.getData('text/plain'));
    const task = boardTasks.find((t) => t.id === id);
    if (task && task.status !== col.dataset.status) moveTask(id, col.dataset.status);
  });
}

// ---------- archive ----------
let archiveTimer;
async function loadArchive() {
  const q = $('#archive-search').value.trim();
  const tasks = await api('GET', `/api/tasks?view=archive&q=${encodeURIComponent(q)}`);
  const list = $('#archive-list');
  list.replaceChildren();
  if (!tasks.length) list.append(el('p', { class: 'meta', text: 'No archived tasks.' }));
  for (const t of tasks) {
    const card = renderCard(t);
    card.draggable = false;
    card.querySelector('.move')?.remove();
    const reopen = el('button', { text: '↩ Reopen as To do', onclick: async (e) => { e.stopPropagation(); await api('PATCH', `/api/tasks/${t.id}`, { status: 'todo' }); loadArchive(); } });
    card.append(el('div', { class: 'move' }, reopen));
    card.querySelector('.meta').append(el('span', { text: `Done ${fmtDateTime(t.done_at)}` }));
    list.append(card);
  }
}
$('#archive-search').addEventListener('input', () => { clearTimeout(archiveTimer); archiveTimer = setTimeout(loadArchive, 250); });

function setView(v) {
  view = v;
  $('#tab-board').classList.toggle('active', v === 'board');
  $('#tab-archive').classList.toggle('active', v === 'archive');
  $('#board-view').hidden = v !== 'board';
  $('#archive-view').hidden = v !== 'archive';
  $('#overdue-wrap').hidden = v !== 'board';
  refresh();
}
$('#tab-board').addEventListener('click', () => setView('board'));
$('#tab-archive').addEventListener('click', () => setView('archive'));
$('#overdue-only').addEventListener('change', renderBoard);

function refresh() {
  return (view === 'board' ? loadBoard() : loadArchive()).catch((e) => alert(e.message));
}

// ---------- dialog ----------
const dialog = $('#task-dialog');

function showError(msg) {
  const p = $('#form-error');
  p.textContent = msg || '';
  p.hidden = !msg;
}

function fillForm(task) {
  $('#f-title').value = task?.title ?? '';
  $('#f-desc').value = task?.description ?? '';
  $('#f-status').value = task?.status ?? 'todo';
  $('#f-priority').value = task?.priority ?? 'medium';
  $('#f-due').value = task?.due_date ?? '';
  showError('');
}

let currentUpdates = [];
function renderTimeline(updates) {
  currentUpdates = updates;
  const ul = $('#timeline');
  ul.replaceChildren();
  for (const u of updates) {
    const when = el('div', { class: 'when', text: fmtDateTime(u.created_at) + (u.edited_at ? ' (edited)' : '') });
    if (u.kind === 'note' && Date.now() - Date.parse(u.created_at) < EDIT_WINDOW_MS) {
      when.append(el('button', { class: 'edit-link', type: 'button', text: 'Edit', onclick: () => editNote(u) }));
    }
    const bodyEl = el('div', { class: 'body', text: u.body });
    const li = el('li', { class: u.kind }, when, bodyEl);
    if (u.edited_at) {
      const panel = el('div', { class: 'history', hidden: '' });
      when.append(el('button', { class: 'edit-link', type: 'button', text: 'History', onclick: () => toggleHistory(u, panel) }));
      li.append(panel);
    }
    li._u = u;
    ul.append(li);
  }
}

async function toggleHistory(u, panel) {
  if (!panel.hidden) { panel.hidden = true; return; }
  try {
    const versions = await api('GET', `/api/updates/${u.id}/history`);
    const canRestore = Date.now() - Date.parse(u.created_at) < EDIT_WINDOW_MS;
    panel.replaceChildren();
    versions.forEach((v, i) => {
      const head = el('div', { class: 'when', text: `v${versions.length - i} · ${fmtDateTime(v.saved_at)}${v.current ? ' · current' : ''}` });
      if (!v.current && canRestore) {
        head.append(el('button', { class: 'edit-link', type: 'button', text: 'Restore', onclick: async () => {
          try {
            await api('PATCH', `/api/updates/${u.id}`, { body: v.body });
            await reloadDialogTask();
          } catch (e) { alert(e.message); }
        } }));
      }
      panel.append(el('div', { class: 'version' }, head, el('div', { class: 'body', text: v.body })));
    });
    panel.hidden = false;
  } catch (e) {
    alert(e.message);
  }
}

function editNote(u) {
  const li = [...$('#timeline').children].find((n) => n._u === u);
  if (!li) return;
  const bodyEl = li.querySelector('.body');
  const ta = el('textarea', { class: 'edit-area', rows: '3', maxlength: '5000' });
  ta.value = u.body;
  const save = el('button', { type: 'button', class: 'primary', text: 'Save', onclick: async () => {
    const body = ta.value;
    if (!body.trim()) return;
    if (body === u.body) return renderTimeline(currentUpdates);
    try {
      await api('PATCH', `/api/updates/${u.id}`, { body });
      await reloadDialogTask();
    } catch (e) {
      alert(e.message);
    }
  } });
  const cancel = el('button', { type: 'button', text: 'Cancel', onclick: () => renderTimeline(currentUpdates) });
  const box = el('div', { class: 'edit-box' }, ta, el('div', { class: 'edit-actions' }, save, cancel));
  bodyEl.replaceWith(box);
  li.querySelector('.edit-link')?.remove();
  ta.focus();
}

async function reloadDialogTask() {
  const task = await api('GET', `/api/tasks/${currentTaskId}`);
  renderTimeline(task.updates);
  return task;
}

// Unsaved drafts survive accidental close (kept in memory only; lost on reload).
const drafts = new Map();
const draftKey = () => currentTaskId ?? 'new';

function getDraft() {
  const key = draftKey();
  if (!drafts.has(key)) drafts.set(key, { form: null, note: '' });
  return drafts.get(key);
}

dialog.addEventListener('input', (e) => {
  const d = getDraft();
  if (e.target.closest('#task-form')) {
    d.form = {
      title: $('#f-title').value,
      description: $('#f-desc').value,
      status: $('#f-status').value,
      priority: $('#f-priority').value,
      due: $('#f-due').value,
    };
  } else if (e.target.closest('#note-form')) {
    d.note = $('#note-body').value;
  }
});

function applyDraft() {
  const d = drafts.get(draftKey());
  if (!d) return;
  if (d.form) {
    $('#f-title').value = d.form.title;
    $('#f-desc').value = d.form.description;
    $('#f-status').value = d.form.status;
    $('#f-priority').value = d.form.priority;
    $('#f-due').value = d.form.due;
  }
  $('#note-body').value = d.note;
}

async function openTask(id) {
  try {
    currentTaskId = id;
    const task = await api('GET', `/api/tasks/${id}`);
    $('#dialog-title').textContent = 'Task';
    fillForm(task);
    $('#delete-task').hidden = false;
    $('#timeline-section').hidden = false;
    $('#note-body').value = '';
    applyDraft();
    renderTimeline(task.updates);
    dialog.showModal();
  } catch (e) {
    alert(e.message);
  }
}

function openNew() {
  currentTaskId = null;
  $('#dialog-title').textContent = 'New task';
  fillForm(null);
  $('#delete-task').hidden = true;
  $('#timeline-section').hidden = true;
  $('#note-body').value = '';
  applyDraft();
  dialog.showModal();
  $('#f-title').focus();
}

$('#new-task').addEventListener('click', openNew);
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', refresh);

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    title: $('#f-title').value,
    description: $('#f-desc').value,
    status: $('#f-status').value,
    priority: $('#f-priority').value,
    due_date: $('#f-due').value || null,
  };
  try {
    if (currentTaskId) await api('PATCH', `/api/tasks/${currentTaskId}`, payload);
    else await api('POST', '/api/tasks', payload);
    const d = drafts.get(draftKey());
    if (d) d.form = null; // form saved; keep any unposted note
    dialog.close();
  } catch (err) {
    showError(err.message);
  }
});

$('#delete-task').addEventListener('click', async () => {
  if (!confirm('Delete this task permanently? This cannot be undone (except from a backup).')) return;
  try {
    await api('DELETE', `/api/tasks/${currentTaskId}`);
    drafts.delete(draftKey());
    dialog.close();
  } catch (err) {
    showError(err.message);
  }
});

$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('#note-body').value;
  try {
    await api('POST', `/api/tasks/${currentTaskId}/updates`, { body });
    $('#note-body').value = '';
    getDraft().note = '';
    await reloadDialogTask();
  } catch (err) {
    showError(err.message);
  }
});

refresh();
