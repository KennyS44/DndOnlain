// Слой синхронизации. Сейчас — локальный (BroadcastChannel + IndexedDB),
// то есть комната живёт между вкладками одного браузера и сохраняется навсегда.
// Когда появится конфиг Firebase, здесь добавится второй адаптер с тем же
// интерфейсом: send / emit / presence / loadState / saveState / assets.

import { idb } from './idb.js';

const HEARTBEAT = 4000;
const AWAY_AFTER = 12000;

export async function createSync(roomId, me) {
  const chan = new BroadcastChannel('dndonlain:' + roomId);
  const handlers = { action: [], event: [], presence: [] };
  const peers = new Map();          // id -> {id, name, role, at}
  let saveTimer = null;

  peers.set(me.id, { ...me, at: Date.now() });

  chan.onmessage = (e) => {
    const m = e.data;
    if (!m || m.from === me.id) return;
    if (m.kind === 'action') emitLocal('action', m.payload);
    else if (m.kind === 'event') emitLocal('event', m.payload);
    else if (m.kind === 'hello') {
      peers.set(m.payload.id, { ...m.payload, at: Date.now() });
      pushPresence();
      // отвечаем новичку, чтобы он тоже нас увидел
      if (m.payload.reply !== false) post('hello', { ...me, reply: false });
    } else if (m.kind === 'bye') {
      peers.delete(m.payload.id);
      pushPresence();
    }
  };

  function emitLocal(type, payload) {
    handlers[type].forEach((fn) => fn(payload));
  }
  function post(kind, payload) {
    chan.postMessage({ kind, from: me.id, payload });
  }
  function pushPresence() {
    const now = Date.now();
    const live = [...peers.values()].filter((p) => now - p.at < AWAY_AFTER);
    emitLocal('presence', live);
  }

  post('hello', { ...me });
  setInterval(() => {
    peers.set(me.id, { ...me, at: Date.now() });
    post('hello', { ...me, reply: false });
    pushPresence();
  }, HEARTBEAT);
  window.addEventListener('pagehide', () => post('bye', { id: me.id }));

  return {
    mode: 'local',
    on(type, fn) { handlers[type].push(fn); },

    /** Действие, меняющее состояние комнаты у всех. */
    send(action) { post('action', action); },

    /** Разовое событие без состояния (полёт кубика). */
    emit(event) { post('event', event); },

    peers: () => [...peers.values()],

    async loadState() {
      const row = await idb.getRoom(roomId);
      return row ? row.state : null;
    },

    /** Снимок пишем с задержкой — на каждый чих в базу не ходим. */
    saveState(state, meta) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        idb.putRoom(roomId, { id: roomId, savedAt: Date.now(), ...meta, state });
      }, 400);
    },

    async putAsset(id, dataUrl) {
      await idb.putAsset(id, dataUrl);
      post('event', { type: 'asset', id });
    },
    getAsset: (id) => idb.getAsset(id),
    delAsset: (id) => idb.delAsset(id),
    allAssets: () => idb.allAssets(),
  };
}
