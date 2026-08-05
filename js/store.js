// Единое состояние комнаты + чистый редьюсер.
// Любое изменение проходит через dispatch: применяется у себя и уходит остальным.

export const STATUSES = ['Отравлен', 'Оглушён', 'Испуган', 'Обездвижен', 'Без сознания', 'Благословлён'];

export function emptyState(room) {
  return {
    room: { name: room.name, playerKey: room.playerKey, dmKey: room.dmKey, createdAt: Date.now() },
    roster: {},                 // id -> {id, name, role}
    locations: {},              // id -> локация
    order: [],                  // порядок локаций
    activeLoc: null,
    library: {},                // id -> {id, name, kind, assetId}
    tokens: {},                 // id -> токен
    init: { order: [], idx: 0, round: 1 },
    chat: [],                   // {id, ts, by, name, kind, text, roll, secret}
    pics: { assets: [], shown: null },
    seq: 0,
  };
}

/** База (и импорт) не хранит пустые объекты и массивы — восстанавливаем форму. */
export function normalize(raw) {
  const s = { ...emptyState({ name: '' }), ...(raw || {}) };
  s.room = { ...s.room, ...(raw && raw.room) };
  s.roster = s.roster || {};
  s.order = s.order || [];
  s.chat = s.chat || [];
  s.library = s.library || {};
  s.locations = s.locations || {};
  s.tokens = s.tokens || {};
  s.pics = { assets: [], shown: null, ...(s.pics || {}) };
  s.pics.assets = s.pics.assets || [];
  s.init = { order: [], idx: 0, round: 1, ...(s.init || {}) };
  s.init.order = s.init.order || [];

  Object.values(s.locations).forEach((l) => {
    l.grid = { size: 70, ox: 0, oy: 0, feet: 5, show: true, ...(l.grid || {}) };
    l.fog = l.fog || {};
    l.drawings = (l.drawings || []).map((d) => ({ ...d, pts: d.pts || [] }));
  });
  Object.values(s.tokens).forEach((t) => {
    t.hp = { cur: 0, max: 0, ...(t.hp || {}) };
    t.statuses = t.statuses || [];
    t.vision = t.vision || 0;
    t.cells = t.cells || 1;
  });
  s.order = s.order.filter((id) => s.locations[id]);
  if (!s.locations[s.activeLoc]) s.activeLoc = s.order[0] || null;
  return s;
}

export function newLocation(name) {
  return {
    id: uid('loc'), name,
    assetId: null,              // карта
    grid: { size: 70, ox: 0, oy: 0, feet: 5, show: true },
    fogOn: false,
    fog: {},                    // "cx,cy" -> 1 (открыто Мастером)
    drawings: [],
    view: null,                 // {x, y, scale} — камера по умолчанию
  };
}

export function newToken(patch) {
  return {
    id: uid('tok'), locId: null, x: 0, y: 0, cells: 1,
    assetId: null, name: 'Существо', kind: 'npc',
    ownerId: null, hp: { cur: 10, max: 10 }, statuses: [],
    vision: 0, ...patch,
  };
}

export function uid(p = 'id') {
  return p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

/** Чистое применение действия. Возвращает новое состояние (мутируем копию верхнего уровня). */
export function reduce(s, a) {
  switch (a.t) {
    case 'room.keys':
      s.room = { ...s.room, ...a.patch }; break;

    case 'roster.seen':
      s.roster = { ...s.roster, [a.member.id]: a.member }; break;

    case 'loc.add':
      s.locations = { ...s.locations, [a.loc.id]: a.loc };
      s.order = [...s.order, a.loc.id];
      if (!s.activeLoc) s.activeLoc = a.loc.id;
      break;
    case 'loc.update': {
      const cur = s.locations[a.id]; if (!cur) break;
      s.locations = { ...s.locations, [a.id]: deepMerge(cur, a.patch) };
      break;
    }
    case 'loc.remove': {
      const next = { ...s.locations }; delete next[a.id];
      s.locations = next;
      s.order = s.order.filter((x) => x !== a.id);
      const toks = { ...s.tokens };
      Object.values(toks).forEach((t) => { if (t.locId === a.id) delete toks[t.id]; });
      s.tokens = toks;
      if (s.activeLoc === a.id) s.activeLoc = s.order[0] || null;
      break;
    }
    case 'loc.active':
      s.activeLoc = a.id; break;

    case 'lib.add':
      s.library = { ...s.library, [a.item.id]: a.item }; break;
    case 'lib.remove': {
      const next = { ...s.library }; delete next[a.id]; s.library = next; break;
    }

    case 'token.add':
      s.tokens = { ...s.tokens, [a.token.id]: a.token }; break;
    case 'token.update': {
      const cur = s.tokens[a.id]; if (!cur) break;
      s.tokens = { ...s.tokens, [a.id]: deepMerge(cur, a.patch) };
      break;
    }
    case 'token.remove': {
      const next = { ...s.tokens }; delete next[a.id]; s.tokens = next;
      s.init = { ...s.init, order: s.init.order.filter((o) => o.id !== a.id) };
      break;
    }

    case 'fog.paint': {
      const loc = s.locations[a.locId]; if (!loc) break;
      const fog = { ...loc.fog };
      a.cells.forEach((k) => { if (a.on) fog[k] = 1; else delete fog[k]; });
      s.locations = { ...s.locations, [a.locId]: { ...loc, fog } };
      break;
    }
    case 'fog.all': {
      const loc = s.locations[a.locId]; if (!loc) break;
      s.locations = { ...s.locations, [a.locId]: { ...loc, fog: {}, fogAllOpen: !!a.open } };
      break;
    }

    case 'draw.add': {
      const loc = s.locations[a.locId]; if (!loc) break;
      s.locations = { ...s.locations, [a.locId]: { ...loc, drawings: [...loc.drawings, a.stroke] } };
      break;
    }
    case 'draw.clear': {
      const loc = s.locations[a.locId]; if (!loc) break;
      const keep = a.by ? loc.drawings.filter((d) => d.by !== a.by) : [];
      s.locations = { ...s.locations, [a.locId]: { ...loc, drawings: keep } };
      break;
    }

    case 'chat.add':
      s.chat = [...s.chat, a.msg].slice(-300); break;

    case 'init.set':
      s.init = { ...s.init, order: a.order, idx: 0, round: 1 }; break;
    case 'init.next': {
      const n = s.init.order.length; if (!n) break;
      const idx = (s.init.idx + 1) % n;
      s.init = { ...s.init, idx, round: idx === 0 ? s.init.round + 1 : s.init.round };
      break;
    }
    case 'init.clear':
      s.init = { order: [], idx: 0, round: 1 }; break;

    case 'pics.add':
      s.pics = { ...s.pics, assets: [...s.pics.assets, ...a.assets] }; break;
    case 'pics.remove':
      s.pics = { ...s.pics, assets: s.pics.assets.filter((x) => x !== a.assetId), shown: s.pics.shown === a.assetId ? null : s.pics.shown };
      break;
    case 'pics.show':
      s.pics = { ...s.pics, shown: a.assetId }; break;

    case 'state.replace':
      return { ...a.state };
  }
  s.seq = (s.seq || 0) + 1;
  return s;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Мини-шина: хранит состояние, раздаёт подписчикам, шлёт действия в sync. */
export function createStore(initial, sync) {
  let state = initial;
  const subs = new Set();
  const notify = () => subs.forEach((fn) => fn(state));

  sync.on('action', (a) => { state = reduce({ ...state }, a); notify(); persist(); });

  let dirty = false;
  function persist() {
    if (dirty) return;
    dirty = true;
    setTimeout(() => { dirty = false; sync.saveState(state, { name: state.room.name }); }, 0);
  }

  return {
    get: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispatch(a) {
      state = reduce({ ...state }, a);
      notify(); persist();
      sync.send(a);
    },
    /** Применить без рассылки (загрузка снимка). */
    hydrate(next) { state = next; notify(); },
  };
}
