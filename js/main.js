// Сборка приложения: вход в комнату, панели, поле, кубики, чат.

import { createSync } from './sync.js';
import { idb } from './idb.js';
import { createStore, emptyState, newLocation, newToken, uid, STATUSES } from './store.js';
import { createBoard } from './board.js';
import { DICE, roll, playAnimation } from './dice.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const COLORS = ['#c9a45a', '#ece6d9', '#b8604a', '#83a05f', '#7fa8c9', '#a678b8', '#e0a05a', '#6f6a5e'];
const SHAPES = [
  { id: 'pen', label: 'Перо' }, { id: 'marker', label: 'Маркер' }, { id: 'line', label: 'Линия' },
  { id: 'arrow', label: 'Стрелка' }, { id: 'rect', label: 'Прямоуг.' }, { id: 'circle', label: 'Круг' },
  { id: 'cone', label: 'Конус' },
];

const app = {};   // me, sync, store, board, isDM

/* ───────────────────────── Вход ───────────────────────── */

function myId() {
  let id = localStorage.getItem('dnd.me');
  if (!id) { id = uid('u'); localStorage.setItem('dnd.me', id); }
  return id;
}
const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\wа-яё-]/gi, '').slice(0, 40);

$$('[data-gate-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-gate-tab]').forEach((x) => x.classList.toggle('is-active', x === b));
  $$('[data-gate-panel]').forEach((p) => { p.hidden = p.dataset.gatePanel !== b.dataset.gateTab; });
}));

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const roomId = slug(f.get('room'));
  const err = $('#create-err');
  if (!roomId) return fail(err, 'Название комнаты не подходит');
  const exists = await idb.getRoom(roomId);
  if (exists) return fail(err, 'Комната с таким названием уже есть — войдите в неё');
  const st = emptyState({ name: f.get('room').trim(), playerKey: f.get('key'), dmKey: f.get('dmkey') });
  await idb.putRoom(roomId, { id: roomId, name: st.room.name, savedAt: Date.now(), state: st });
  start(roomId, { id: myId(), name: f.get('name').trim(), role: 'dm' });
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const roomId = slug(f.get('room'));
  const err = $('#join-err');
  const row = await idb.getRoom(roomId);
  if (!row) return fail(err, 'Комната не найдена. Мастер должен создать её.');
  const dmkey = (f.get('dmkey') || '').trim();
  const isDM = dmkey && dmkey === row.state.room.dmKey;
  if (!isDM && f.get('key') !== row.state.room.playerKey) return fail(err, 'Неверный ключ комнаты');
  if (dmkey && !isDM) return fail(err, 'Неверный ключ Мастера');
  start(roomId, { id: myId(), name: f.get('name').trim(), role: isDM ? 'dm' : 'player' });
});

function fail(el, msg) { el.textContent = msg; el.hidden = false; }

/* ───────────────────────── Запуск стола ───────────────────────── */

async function start(roomId, me) {
  app.me = me;
  app.isDM = me.role === 'dm';
  app.sync = await createSync(roomId, me);

  const saved = await app.sync.loadState();
  app.store = createStore(saved || emptyState({ name: roomId }), app.sync);

  $('#gate').hidden = true;
  $('#app').hidden = false;
  document.body.classList.toggle('is-dm', app.isDM);
  if (!app.isDM) $$('.dm-only').forEach((el) => el.remove());

  $('#room-name').textContent = app.store.get().room.name;
  $('#role-badge').textContent = app.isDM ? 'Мастер' : 'Игрок';

  app.board = createBoard({
    canvas: $('#board'), store: app.store, sync: app.sync,
    me, isDM: app.isDM,
    onTokenOpen: openTokenCard,
    onViewChange: (v) => { $('#zoom-val').textContent = Math.round(v.scale * 100) + '%'; },
  });

  app.store.dispatch({ t: 'roster.seen', member: { id: me.id, name: me.name, role: me.role } });
  app.store.subscribe(renderAll);
  app.sync.on('event', onRemoteEvent);
  app.sync.on('presence', renderMembers);

  wireUI();
  renderAll(app.store.get());
  app.board.fit();
  say(`${me.name} за столом (${app.isDM ? 'Мастер' : 'игрок'})`, 'system');
}

function onRemoteEvent(ev) {
  if (ev.type === 'dice') playAnimation($('#dice-stage'), ev.result, ev.caption);
  else if (ev.type === 'asset') { app.board.invalidateAsset(ev.id); renderAll(app.store.get()); }
}

/* ───────────────────────── Работа с картинками ───────────────────────── */

async function fileToAsset(file, maxSide) {
  const dataUrl = await new Promise((res) => {
    const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file);
  });
  const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = dataUrl; });
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (k === 1 && dataUrl.length < 1.5e6) return { id: uid('a'), url: dataUrl };
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { id: uid('a'), url: c.toDataURL('image/webp', .85) };
}

async function storeFiles(files, maxSide) {
  const out = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const a = await fileToAsset(f, maxSide);
    await app.sync.putAsset(a.id, a.url);
    out.push({ ...a, name: f.name.replace(/\.[^.]+$/, '').slice(0, 24) });
  }
  return out;
}

/* ───────────────────────── Отрисовка панелей ───────────────────────── */

function renderAll(s) {
  renderLocations(s);
  renderLibrary(s);
  renderChat(s);
  renderInit(s);
  renderPics(s);
  const loc = s.activeLoc ? s.locations[s.activeLoc] : null;
  $('#loc-title').textContent = loc ? loc.name : '';
  $('#empty-hint').hidden = !!loc;
  if (app.isDM && loc) {
    setVal('#grid-size', loc.grid.size); setVal('#grid-ox', loc.grid.ox);
    setVal('#grid-oy', loc.grid.oy); setVal('#grid-feet', loc.grid.feet);
    $('#grid-show').checked = loc.grid.show;
    $('#fog-on').checked = loc.fogOn;
  }
  app.board.render();
  updateShowcase(s);
}
function setVal(sel, v) { const el = $(sel); if (el && document.activeElement !== el) el.value = v; }

function renderLocations(s) {
  const list = $('#locations-list'); if (!list) return;
  list.innerHTML = '';
  s.order.forEach((id) => {
    const l = s.locations[id];
    const row = el('div', 'list-item' + (id === s.activeLoc ? ' is-active' : ''));
    const thumb = el('img', 'thumb'); thumb.alt = '';
    if (l.assetId) app.sync.getAsset(l.assetId).then((u) => { if (u) thumb.src = u; });
    const name = el('span', 'name', l.name);
    row.append(thumb, name);
    row.addEventListener('click', () => { app.store.dispatch({ t: 'loc.active', id }); setTimeout(() => app.board.fit(), 30); });

    const up = el('label', 'mini file-btn', '🗺');
    up.title = 'Загрузить карту';
    const inp = el('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('change', async () => {
      const [a] = await storeFiles(inp.files, 2560);
      if (a) { app.store.dispatch({ t: 'loc.update', id, patch: { assetId: a.id } }); setTimeout(() => app.board.fit(), 60); }
    });
    up.append(inp);
    up.addEventListener('click', (e) => e.stopPropagation());

    const ren = el('button', 'mini', '✎');
    ren.title = 'Переименовать';
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = prompt('Название локации', l.name);
      if (v) app.store.dispatch({ t: 'loc.update', id, patch: { name: v.slice(0, 40) } });
    });
    const del = el('button', 'mini', '×');
    del.title = 'Удалить';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Удалить локацию «${l.name}» вместе с её токенами?`)) app.store.dispatch({ t: 'loc.remove', id });
    });
    row.append(up, ren, del);
    list.append(row);
  });
}

let libFilter = 'all';
function renderLibrary(s) {
  const grid = $('#lib-grid'); if (!grid) return;
  grid.innerHTML = '';
  Object.values(s.library)
    .filter((it) => libFilter === 'all' || it.kind === libFilter)
    .forEach((it) => {
      const card = el('div', 'lib-item');
      card.draggable = true;
      const img = el('img'); img.alt = it.name;
      app.sync.getAsset(it.assetId).then((u) => { if (u) img.src = u; });
      const cap = el('div', 'cap', it.name);
      const del = el('button', 'del', '×');
      del.addEventListener('click', () => app.store.dispatch({ t: 'lib.remove', id: it.id }));
      card.append(img, cap, del);
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/lib', it.id));
      card.addEventListener('dblclick', () => dropToken(it.id, null));
      grid.append(card);
    });
}

function renderChat(s) {
  const feed = $('#chat-feed'), rolls = $('#rolls-feed');
  feed.innerHTML = ''; rolls.innerHTML = '';
  s.chat.forEach((m) => {
    if (m.secret && !app.isDM) return;
    const node = msgNode(m);
    (m.kind === 'roll' ? rolls : feed).append(node);
  });
  feed.scrollTop = feed.scrollHeight;
  rolls.scrollTop = rolls.scrollHeight;
}

function msgNode(m) {
  const d = el('div', `msg ${m.kind}${m.secret ? ' secret' : ''}`);
  const time = new Date(m.ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (m.kind === 'roll') {
    d.innerHTML = `<span class="time">${time}</span><span class="who">${esc(m.name)}</span>
      <div class="body">${m.secret ? '🤫 ' : ''}${esc(m.roll.formula)} → <span class="total">${m.roll.total}</span>
      <span style="color:var(--muted);font-size:14px"> [${m.roll.dice.join(', ')}]${m.roll.mod ? ` ${m.roll.mod > 0 ? '+' : ''}${m.roll.mod}` : ''}</span></div>`;
  } else if (m.kind === 'system') {
    d.innerHTML = `<div class="body">${esc(m.text)}</div>`;
  } else {
    d.innerHTML = `<span class="time">${time}</span><span class="who">${esc(m.name)}</span><div class="body">${esc(m.text)}</div>`;
  }
  return d;
}

function renderInit(s) {
  const list = $('#init-list');
  list.innerHTML = '';
  $('#round-line').textContent = s.init.order.length ? `Раунд ${s.init.round}` : 'Порядок не выставлен';
  s.init.order.forEach((entry, i) => {
    const t = s.tokens[entry.id];
    if (!t) return;
    const row = el('div', 'init-item' + (i === s.init.idx ? ' is-turn' : ''));
    const head = el('div', 'init-head');
    const img = el('img'); img.alt = '';
    if (t.assetId) app.sync.getAsset(t.assetId).then((u) => { if (u) img.src = u; });
    head.append(img, el('span', 'nm', t.name), el('span', 'iv', String(entry.v)));
    row.append(head);

    if (t.hp && t.hp.max > 0 && (app.isDM || t.hpPublic !== false)) {
      const bar = el('div', 'hp-bar');
      const fill = el('div', 'hp-fill');
      fill.style.width = Math.max(0, Math.min(100, (t.hp.cur / t.hp.max) * 100)) + '%';
      bar.append(fill); row.append(bar);
      if (app.isDM) {
        const hp = el('div', 'hp-row');
        const cur = numInput(t.hp.cur, (v) => app.store.dispatch({ t: 'token.update', id: t.id, patch: { hp: { cur: v } } }));
        const max = numInput(t.hp.max, (v) => app.store.dispatch({ t: 'token.update', id: t.id, patch: { hp: { max: v } } }));
        hp.append(cur, el('span', '', '/'), max, el('span', '', 'хиты'));
        row.append(hp);
      }
    }
    if (app.isDM) {
      const st = el('div', 'status-row');
      STATUSES.forEach((name) => {
        const on = (t.statuses || []).includes(name);
        const b = el('button', 'status' + (on ? ' on' : ''), name);
        b.addEventListener('click', () => {
          const next = on ? t.statuses.filter((x) => x !== name) : [...(t.statuses || []), name];
          app.store.dispatch({ t: 'token.update', id: t.id, patch: { statuses: next } });
        });
        st.append(b);
      });
      row.append(st);
    } else if ((t.statuses || []).length) {
      const st = el('div', 'status-row');
      t.statuses.forEach((n) => st.append(el('span', 'status on', n)));
      row.append(st);
    }
    list.append(row);
  });
}

function numInput(value, onChange) {
  const i = el('input'); i.type = 'number'; i.value = value;
  i.addEventListener('change', () => onChange(Number(i.value) || 0));
  return i;
}

function renderPics(s) {
  const grid = $('#pics-grid'); if (!grid) return;
  grid.innerHTML = '';
  s.pics.assets.forEach((id) => {
    const card = el('div', 'lib-item' + (s.pics.shown === id ? ' is-shown' : ''));
    const img = el('img'); img.alt = '';
    app.sync.getAsset(id).then((u) => { if (u) img.src = u; });
    const del = el('button', 'del', '×');
    del.addEventListener('click', (e) => { e.stopPropagation(); app.store.dispatch({ t: 'pics.remove', assetId: id }); });
    card.append(img, del);
    card.addEventListener('click', () => app.store.dispatch({ t: 'pics.show', assetId: s.pics.shown === id ? null : id }));
    grid.append(card);
  });
}

let showcaseHiddenFor = null;
function updateShowcase(s) {
  const box = $('#showcase'), img = $('#showcase-img');
  const id = s.pics.shown;
  if (!id || showcaseHiddenFor === id) { box.hidden = true; return; }
  app.sync.getAsset(id).then((u) => { if (u) { img.src = u; box.hidden = false; } });
}

function renderMembers(list) {
  const box = $('#members');
  box.innerHTML = '';
  list.forEach((p) => {
    const d = el('span', 'dot', p.name.slice(0, 1).toUpperCase());
    d.style.background = p.role === 'dm' ? 'var(--gold)' : '#7fa8c9';
    d.title = p.name + (p.role === 'dm' ? ' — Мастер' : '');
    box.append(d);
  });
  const ml = $('#members-list');
  if (ml) {
    ml.innerHTML = '';
    Object.values(app.store.get().roster).forEach((m) => {
      const online = list.some((p) => p.id === m.id);
      const row = el('div', 'list-item');
      row.append(el('span', 'name', m.name + (m.role === 'dm' ? ' — Мастер' : '')));
      row.append(el('span', 'badge', online ? 'в сети' : 'нет'));
      ml.append(row);
    });
  }
}

/* ───────────────────────── Карточка токена ───────────────────────── */

function openTokenCard(t, screenPos) {
  const card = $('#token-card');
  card.innerHTML = '';
  card.hidden = false;
  const wrap = $('#board-wrap').getBoundingClientRect();
  card.style.left = Math.min(wrap.width - 262, Math.max(8, screenPos.x + 12)) + 'px';
  card.style.top = Math.min(wrap.height - 260, Math.max(8, screenPos.y + 12)) + 'px';

  const close = el('button', 'icon-btn close', '×');
  close.addEventListener('click', () => { card.hidden = true; });
  card.append(close, el('h4', '', t.name));

  if (!app.isDM) {
    const info = el('div', 'hint',
      `${t.hp && t.hp.max ? `Хиты: ${t.hp.cur}/${t.hp.max}. ` : ''}${(t.statuses || []).join(', ') || 'Состояний нет'}`);
    card.append(info);
    return;
  }

  card.append(field('Имя', textInput(t.name, (v) => upd(t.id, { name: v }))));
  card.append(field('Размер, клеток', numInput(t.cells, (v) => upd(t.id, { cells: Math.max(1, Math.min(6, v)) }))));
  card.append(field('Хиты (тек./макс.)', pair(
    numInput(t.hp.cur, (v) => upd(t.id, { hp: { cur: v } })),
    numInput(t.hp.max, (v) => upd(t.id, { hp: { max: v } })))));
  card.append(field('Обзор, футов (0 — нет)', numInput(t.vision, (v) => upd(t.id, { vision: Math.max(0, v) }))));

  const sel = el('select', 'sel');
  sel.append(new Option('— ничей —', ''));
  Object.values(app.store.get().roster).forEach((m) => {
    const o = new Option(m.name + (m.role === 'dm' ? ' (Мастер)' : ''), m.id);
    if (t.ownerId === m.id) o.selected = true;
    sel.append(o);
  });
  sel.addEventListener('change', () => upd(t.id, { ownerId: sel.value || null }));
  card.append(field('Кому принадлежит', sel));

  const inInit = app.store.get().init.order.some((o) => o.id === t.id);
  const row = el('div', 'row-2');
  const bInit = el('button', 'btn btn-soft btn-sm', inInit ? 'Убрать из боя' : 'В бой (d20)');
  bInit.addEventListener('click', () => { toggleInit(t.id); card.hidden = true; });
  const bDel = el('button', 'btn btn-soft btn-sm', 'Удалить');
  bDel.addEventListener('click', () => { app.store.dispatch({ t: 'token.remove', id: t.id }); card.hidden = true; });
  row.append(bInit, bDel);
  card.append(el('div', 'divider'), row);
}

const upd = (id, patch) => app.store.dispatch({ t: 'token.update', id, patch });
function field(label, input) {
  const f = el('label', 'field');
  f.append(el('span', '', label), input);
  return f;
}
function pair(a, b) { const d = el('div', 'row-2'); d.append(a, b); return d; }
function textInput(value, onChange) {
  const i = el('input'); i.value = value;
  i.addEventListener('change', () => onChange(i.value.slice(0, 32)));
  return i;
}

function toggleInit(tokenId) {
  const s = app.store.get();
  const has = s.init.order.some((o) => o.id === tokenId);
  const order = has ? s.init.order.filter((o) => o.id !== tokenId)
    : [...s.init.order, { id: tokenId, v: roll(20).total }].sort((a, b) => b.v - a.v);
  app.store.dispatch({ t: 'init.set', order });
}

/* ───────────────────────── Токены на поле ───────────────────────── */

function dropToken(libId, worldPos) {
  const s = app.store.get();
  const it = s.library[libId];
  if (!it || !s.activeLoc) return;
  const p = worldPos || app.board.screenToWorld($('#board').clientWidth / 2, $('#board').clientHeight / 2);
  const c = app.board.cellCenter(p.x, p.y);
  const token = newToken({
    locId: s.activeLoc, x: c.x, y: c.y, assetId: it.assetId, name: it.name, kind: it.kind,
    vision: it.kind === 'pc' ? 30 : 0,
  });
  app.store.dispatch({ t: 'token.add', token });
}

/* ───────────────────────── Чат и броски ───────────────────────── */

function say(text, kind = 'chat', extra = {}) {
  app.store.dispatch({
    t: 'chat.add',
    msg: { id: uid('m'), ts: Date.now(), by: app.me.id, name: app.me.name, kind, text, ...extra },
  });
}

let diceMode = 'open';
function doRoll(sides) {
  const count = Math.max(1, Math.min(20, Number($('#dice-count').value) || 1));
  const mod = Number($('#dice-mod').value) || 0;
  const adv = $('#dice-adv').checked && sides === 20 ? 'adv' : null;
  const r = roll(sides, count, mod, adv);
  const secret = diceMode === 'secret' && app.isDM;
  say('', 'roll', { roll: r, secret });
  const caption = `${app.me.name}: ${r.formula}`;
  playAnimation($('#dice-stage'), r, caption + (secret ? ' · тайно' : ''));
  if (!secret) app.sync.emit({ type: 'dice', result: r, caption });
}

/* ───────────────────────── Провода интерфейса ───────────────────────── */

function wireUI() {
  // инструменты
  $$('#toolbar .tool').forEach((b) => b.addEventListener('click', () => {
    $$('#toolbar .tool').forEach((x) => x.classList.toggle('is-active', x === b));
    app.board.setTool(b.dataset.tool);
    $('#draw-bar').hidden = b.dataset.tool !== 'draw';
    $('#token-card').hidden = true;
  }));

  // панель рисования
  const colorBox = $('#draw-colors');
  COLORS.forEach((c, i) => {
    const s = el('button', 'swatch' + (i === 0 ? ' is-active' : ''));
    s.style.background = c;
    s.addEventListener('click', () => {
      $$('.swatch').forEach((x) => x.classList.remove('is-active'));
      s.classList.add('is-active');
      app.board.setDraw({ color: c });
    });
    colorBox.append(s);
  });
  const shapeBox = $('#draw-shapes');
  SHAPES.forEach((sh, i) => {
    const b = el('button', 'shape' + (i === 0 ? ' is-active' : ''), sh.label);
    b.addEventListener('click', () => {
      $$('.shape').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      app.board.setDraw({ shape: sh.id });
    });
    shapeBox.append(b);
  });
  $('#draw-width').addEventListener('input', (e) => app.board.setDraw({ width: Number(e.target.value) }));
  $('#draw-clear').addEventListener('click', () => {
    const s = app.store.get();
    if (s.activeLoc) app.store.dispatch({ t: 'draw.clear', locId: s.activeLoc, by: app.isDM ? null : app.me.id });
  });

  // зум
  $('#zoom-in').addEventListener('click', () => app.board.zoomBy(1.2));
  $('#zoom-out').addEventListener('click', () => app.board.zoomBy(1 / 1.2));
  $('#zoom-fit').addEventListener('click', () => app.board.fit());

  // вкладки правой панели
  $$('[data-rtab]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-rtab]').forEach((x) => x.classList.toggle('is-active', x === b));
    $$('[data-rpanel]').forEach((p) => { p.hidden = p.dataset.rpanel !== b.dataset.rtab; });
  }));

  // чат
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#chat-input').value.trim();
    if (!v) return;
    say(v);
    $('#chat-input').value = '';
  });

  // кубики
  const btns = $('#dice-buttons');
  DICE.forEach((d) => {
    const b = el('button', 'die-btn', 'd' + d);
    b.addEventListener('click', () => doRoll(d));
    btns.append(b);
  });
  $('#btn-dice').addEventListener('click', () => { $('#dice-tray').hidden = !$('#dice-tray').hidden; });
  $('#dice-close').addEventListener('click', () => { $('#dice-tray').hidden = true; });
  $$('[data-dicemode]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-dicemode]').forEach((x) => x.classList.toggle('is-active', x === b));
    diceMode = b.dataset.dicemode;
    $('#dice-hint').textContent = diceMode === 'secret' ? 'Результат увидит только Мастер.' : 'Бросок видят все за столом.';
  }));

  // картинки на общий экран
  $('#showcase-close').addEventListener('click', () => {
    showcaseHiddenFor = app.store.get().pics.shown;
    $('#showcase').hidden = true;
  });

  // мобильные панели
  const btnPanel = $('#btn-panel');
  if (btnPanel) btnPanel.addEventListener('click', () => {
    $$('.panel').forEach((p) => p.classList.toggle('is-open'));
  });

  wireDM();
  wireDrop();
}

function wireDM() {
  if (!app.isDM) return;

  $$('[data-ltab]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-ltab]').forEach((x) => x.classList.toggle('is-active', x === b));
    $$('[data-lpanel]').forEach((p) => { p.hidden = p.dataset.lpanel !== b.dataset.ltab; });
  }));
  $$('[data-libfilter]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-libfilter]').forEach((x) => x.classList.toggle('is-active', x === b));
    libFilter = b.dataset.libfilter;
    renderLibrary(app.store.get());
  }));

  $('#btn-add-location').addEventListener('click', () => {
    const name = prompt('Название локации', 'Новая локация');
    if (!name) return;
    app.store.dispatch({ t: 'loc.add', loc: newLocation(name.slice(0, 40)) });
  });

  const patchLoc = (patch) => {
    const id = app.store.get().activeLoc;
    if (id) app.store.dispatch({ t: 'loc.update', id, patch });
  };
  $('#grid-size').addEventListener('input', (e) => patchLoc({ grid: { size: Math.max(10, Number(e.target.value) || 70) } }));
  $('#grid-ox').addEventListener('input', (e) => patchLoc({ grid: { ox: Number(e.target.value) || 0 } }));
  $('#grid-oy').addEventListener('input', (e) => patchLoc({ grid: { oy: Number(e.target.value) || 0 } }));
  $('#grid-feet').addEventListener('input', (e) => patchLoc({ grid: { feet: Math.max(1, Number(e.target.value) || 5) } }));
  $('#grid-show').addEventListener('change', (e) => patchLoc({ grid: { show: e.target.checked } }));
  $('#fog-on').addEventListener('change', (e) => patchLoc({ fogOn: e.target.checked }));
  $('#fog-brush').addEventListener('input', (e) => app.board.setFogBrush(Math.max(1, Number(e.target.value) || 2)));
  $('#fog-reveal-all').addEventListener('click', () => {
    const id = app.store.get().activeLoc;
    if (id) app.store.dispatch({ t: 'fog.all', locId: id, open: true });
  });
  $('#fog-hide-all').addEventListener('click', () => {
    const id = app.store.get().activeLoc;
    if (id) app.store.dispatch({ t: 'fog.all', locId: id, open: false });
  });

  $('#lib-upload').addEventListener('change', async (e) => {
    const kind = $('#lib-kind').value;
    const assets = await storeFiles(e.target.files, 256);
    assets.forEach((a) => app.store.dispatch({
      t: 'lib.add', item: { id: uid('lib'), name: a.name, kind, assetId: a.id },
    }));
    e.target.value = '';
  });

  $('#pics-upload').addEventListener('change', async (e) => {
    const assets = await storeFiles(e.target.files, 1800);
    app.store.dispatch({ t: 'pics.add', assets: assets.map((a) => a.id) });
    e.target.value = '';
  });
  $('#pics-hide').addEventListener('click', () => app.store.dispatch({ t: 'pics.show', assetId: null }));

  $('#init-roll-all').addEventListener('click', () => {
    const s = app.store.get();
    const order = Object.values(s.tokens)
      .filter((t) => t.locId === s.activeLoc)
      .map((t) => ({ id: t.id, v: roll(20).total }))
      .sort((a, b) => b.v - a.v);
    app.store.dispatch({ t: 'init.set', order });
    say('Инициатива брошена', 'system');
  });
  $('#init-next').addEventListener('click', () => app.store.dispatch({ t: 'init.next' }));

  const s0 = app.store.get();
  $('#key-player').value = s0.room.playerKey || '';
  $('#key-dm').value = s0.room.dmKey || '';
  $('#btn-save-keys').addEventListener('click', () => {
    app.store.dispatch({ t: 'room.keys', patch: { playerKey: $('#key-player').value, dmKey: $('#key-dm').value } });
    say('Ключи комнаты изменены', 'system');
  });

  $('#btn-export').addEventListener('click', exportCampaign);
  $('#btn-import').addEventListener('change', importCampaign);
}

function wireDrop() {
  const wrap = $('#board-wrap');
  wrap.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/lib')) e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    const libId = e.dataTransfer.getData('text/lib');
    if (!libId) return;
    e.preventDefault();
    const r = $('#board').getBoundingClientRect();
    dropToken(libId, app.board.screenToWorld(e.clientX - r.left, e.clientY - r.top));
  });
}

/* ───────────────────────── Сейв кампании ───────────────────────── */

async function exportCampaign() {
  const state = app.store.get();
  const used = new Set();
  Object.values(state.locations).forEach((l) => l.assetId && used.add(l.assetId));
  Object.values(state.library).forEach((i) => used.add(i.assetId));
  Object.values(state.tokens).forEach((t) => t.assetId && used.add(t.assetId));
  state.pics.assets.forEach((a) => used.add(a));
  const assets = {};
  for (const id of used) assets[id] = await app.sync.getAsset(id);
  const blob = new Blob([JSON.stringify({ v: 1, state, assets })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.room.name || 'кампания'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importCampaign(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Импорт заменит текущую комнату. Продолжить?')) { e.target.value = ''; return; }
  const data = JSON.parse(await file.text());
  for (const [id, url] of Object.entries(data.assets || {})) if (url) await app.sync.putAsset(id, url);
  app.store.dispatch({ t: 'state.replace', state: data.state });
  e.target.value = '';
  setTimeout(() => app.board.fit(), 100);
}

/* ───────────────────────── Мелочи ───────────────────────── */

function el(tag, cls = '', text = '') {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('click', (e) => {
  const card = $('#token-card');
  if (!card.hidden && !card.contains(e.target) && e.target.id !== 'board') card.hidden = true;
});
