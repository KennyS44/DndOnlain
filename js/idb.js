// Локальное хранилище: снимок комнаты + картинки (карты, иконки, хендауты).
// Всё лежит в IndexedDB, поэтому переживает перезагрузку и не упирается в 5 МБ localStorage.

const DB_NAME = 'dndonlain';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rooms')) db.createObjectStore('rooms');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}

export const idb = {
  getRoom: (id) => tx('rooms', 'readonly', (s) => s.get(id)),
  putRoom: (id, value) => tx('rooms', 'readwrite', (s) => s.put(value, id)),
  listRooms: () => tx('rooms', 'readonly', (s) => s.getAll()),
  getAsset: (id) => tx('assets', 'readonly', (s) => s.get(id)),
  putAsset: (id, dataUrl) => tx('assets', 'readwrite', (s) => s.put(dataUrl, id)),
  delAsset: (id) => tx('assets', 'readwrite', (s) => s.delete(id)),
  allAssets: async () => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('assets', 'readonly');
      const store = t.objectStore('assets');
      const keys = store.getAllKeys();
      const vals = store.getAll();
      t.oncomplete = () => {
        const out = {};
        keys.result.forEach((k, i) => { out[k] = vals.result[i]; });
        res(out);
      };
      t.onerror = () => rej(t.error);
    });
  },
};
