/* Capa de almacenamiento local (IndexedDB). Todo queda guardado en el dispositivo. */
const DB = (() => {
  const NAME = 'pedidos-colombina';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'code' });
        if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('orders')) {
          const s = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
          s.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function reqP(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      let result;
      Promise.resolve(fn(t.objectStore(store))).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
    get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
    put: (store, val) => tx(store, 'readwrite', s => reqP(s.put(val))),
    del: (store, key) => tx(store, 'readwrite', s => reqP(s.delete(key))),
    replaceAll: (store, list) => tx(store, 'readwrite', s => { s.clear(); list.forEach(v => s.put(v)); return list.length; }),
    putMany: (store, list) => tx(store, 'readwrite', s => { list.forEach(v => s.put(v)); return list.length; }),
    getMeta: async (key, def = null) => { const r = await DB.get('meta', key); return r ? r.value : def; },
    setMeta: (key, value) => DB.put('meta', { key, value }),
  };
})();
