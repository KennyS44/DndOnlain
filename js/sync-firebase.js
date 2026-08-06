// Адаптер синхронизации на Firebase Realtime Database.
// Интерфейс тот же, что у локального (js/sync.js): on / send / emit /
// peers / loadState / saveState / putAsset / getAsset.
//
// Раскладка данных:
//   rooms/{путь}/state      — снимок комнаты (пишут все, действия у всех одинаковые)
//   rooms/{путь}/actions    — поток изменений
//   rooms/{путь}/events     — разовые события (полёт кубика)
//   rooms/{путь}/presence   — кто сейчас за столом
//   rooms/{путь}/assets     — карты, иконки, картинки (data URL)
//
// Путь комнаты содержит отпечаток её ключа, поэтому чужой в неё не попадёт,
// не зная ключа.

import { idb } from './idb.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.5/';
const KEEP_ACTIONS = 100;

export async function createFirebaseSync(roomPath, me, cfg) {
  const [{ initializeApp }, db] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-database.js'),
  ]);
  const database = db.getDatabase(initializeApp(cfg));
  const base = 'rooms/' + roomPath;
  const R = (p) => db.ref(database, base + '/' + p);

  const handlers = { action: [], event: [], presence: [] };
  const emitLocal = (type, payload) => handlers[type].forEach((fn) => fn(payload));
  let saveTimer = null;
  let dirtySince = 0;
  let peers = [];
  // счётчики трафика — видно, кто и сколько льёт в базу
  const stats = { actionsSent: 0, actionsGot: 0, stateWrites: 0, bytesSent: 0, bytesGot: 0 };

  // всё, что было до нашего прихода, пропускаем: ключи push упорядочены по времени
  const lastKey = async (path) => {
    const snap = await db.get(db.query(R(path), db.limitToLast(1)));
    let k = '';
    snap.forEach((c) => { k = c.key; });
    return k;
  };
  const [afterAction, afterEvent] = await Promise.all([lastKey('actions'), lastKey('events')]);

  db.onChildAdded(db.query(R('actions'), db.limitToLast(40)), (snap) => {
    if (snap.key <= afterAction) return;
    const v = snap.val();
    if (!v || v.from === me.id) return;
    stats.actionsGot++;
    stats.bytesGot += JSON.stringify(v).length;
    emitLocal('action', v.a);
  });

  db.onChildAdded(db.query(R('events'), db.limitToLast(10)), (snap) => {
    if (snap.key <= afterEvent) return;
    const v = snap.val();
    if (!v || v.from === me.id) return;
    emitLocal('event', v.e);
  });

  // присутствие. Роль уточняется уже после подключения (ключ Мастера проверяется
  // по загруженному состоянию), поэтому запись о себе умеет обновляться.
  let who = { ...me };
  const mine = R('presence/' + me.id);
  db.onDisconnect(mine).remove();
  db.set(mine, { ...who, at: Date.now() });
  setInterval(() => db.set(mine, { ...who, at: Date.now() }), 20000);
  db.onValue(R('presence'), (snap) => {
    peers = Object.values(snap.val() || {});
    emitLocal('presence', peers);
  });

  async function prune() {
    const snap = await db.get(R('actions'));
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });
    if (keys.length <= KEEP_ACTIONS * 2) return;
    const drop = {};
    keys.slice(0, keys.length - KEEP_ACTIONS).forEach((k) => { drop[k] = null; });
    db.update(R('actions'), drop);
  }

  return {
    mode: 'firebase',
    on(type, fn) { handlers[type].push(fn); },

    stats: () => ({ ...stats }),

    /** Уточнить, кто мы за столом (роль выясняется после входа). */
    updateMe(patch) {
      who = { ...who, ...patch };
      db.set(mine, { ...who, at: Date.now() });
    },

    send(a) {
      const row = { from: me.id, ts: Date.now(), a: clean(a) };
      stats.actionsSent++;
      stats.bytesSent += JSON.stringify(row).length;
      db.push(R('actions'), row);
      if (Math.random() < 0.05) prune();
    },
    emit(e) {
      db.push(R('events'), { from: me.id, ts: Date.now(), e: clean(e) });
    },
    peers: () => peers,

    async loadState() {
      const snap = await db.get(R('state'));
      return snap.exists() ? snap.val() : null;
    },
    saveState(state) {
      // при непрерывной возне откладывать бесконечно нельзя — пишем хотя бы раз в 6 секунд
      if (!dirtySince) dirtySince = Date.now();
      const overdue = Date.now() - dirtySince > 6000;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        dirtySince = 0;
        const payload = clean(state);
        stats.stateWrites++;
        stats.bytesSent += JSON.stringify(payload).length;
        db.set(R('state'), payload);
      }, overdue ? 0 : 900);
    },

    async putAsset(id, dataUrl) {
      await idb.putAsset(id, dataUrl);
      await db.set(R('assets/' + id), dataUrl);
      db.push(R('events'), { from: me.id, ts: Date.now(), e: { type: 'asset', id } });
    },
    async getAsset(id) {
      const local = await idb.getAsset(id);
      if (local) return local;
      const snap = await db.get(R('assets/' + id));
      const url = snap.val();
      if (url) idb.putAsset(id, url);
      return url;
    },
    delAsset: (id) => Promise.all([idb.delAsset(id), db.remove(R('assets/' + id))]),
  };
}

/** RTDB не принимает undefined и не хранит пустые объекты — чистим перед записью. */
function clean(v) {
  return JSON.parse(JSON.stringify(v, (k, val) => (val === undefined ? null : val)));
}

/** Отпечаток ключа комнаты: путь знают только те, кому дали ключ. */
export function roomFingerprint(name, key) {
  let h = 0x811c9dc5;
  for (const ch of (name + '::' + key)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
