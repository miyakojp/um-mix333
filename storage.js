// UtaMix storage — everything stays in this device's IndexedDB. Nothing is uploaded.
const DB_NAME = 'utamix';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('analysis')) db.createObjectStore('analysis', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存に失敗しました（容量不足の可能性があります）'));
  });
}

export const Store = {
  async requestPersist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* ignore */ }
    return false;
  },
  async estimate() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    return null;
  },
  listProjects() { return tx('projects', 'readonly', (s) => s.getAll()); },
  getProject(id) { return tx('projects', 'readonly', (s) => s.get(id)); },
  putProject(p) { return tx('projects', 'readwrite', (s) => s.put(p)); },
  deleteProject(id) { return tx('projects', 'readwrite', (s) => s.delete(id)); },
  // audio: {id, sr, channels: [Float32Array]}
  putAudio(a) { return tx('audio', 'readwrite', (s) => s.put(a)); },
  getAudio(id) { return tx('audio', 'readonly', (s) => s.get(id)); },
  deleteAudio(id) { return tx('audio', 'readwrite', (s) => s.delete(id)); },
  putAnalysis(a) { return tx('analysis', 'readwrite', (s) => s.put(a)); },
  getAnalysis(id) { return tx('analysis', 'readonly', (s) => s.get(id)); },
  deleteAnalysis(id) { return tx('analysis', 'readwrite', (s) => s.delete(id)); },
  async allAudioIds() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('audio', 'readonly');
      const r = t.objectStore('audio').getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
};

export function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
