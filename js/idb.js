/* ============================================================
 * idb.js — 아주 작은 IndexedDB 래퍼 (외부 라이브러리 없음)
 *   memos : 메모 레코드 (keyPath: id)
 *   blobs : 이미지 원본 파일 (keyPath: key)
 *   meta  : 동기화 커서 등 (keyPath: k)
 * IndexedDB 를 쓸 수 없는 환경(시크릿 모드 등)에서는
 * 자동으로 메모리 저장소로 대체 동작한다.
 * ============================================================ */
(function () {
  'use strict';

  var DB_NAME = 'memo-app-db';
  var DB_VERSION = 1;

  var dbPromise = null;
  var fallback = false;
  var mem = { memos: new Map(), blobs: new Map(), meta: new Map() };

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('memos')) {
          var s = db.createObjectStore('memos', { keyPath: 'id' });
          s.createIndex('created_at', 'created_at');
          s.createIndex('updated_at', 'updated_at');
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb open failed')); };
      req.onblocked = function () { reject(new Error('idb blocked')); };
    }).catch(function (err) {
      fallback = true;
      console.warn('[memo] IndexedDB 사용 불가 → 메모리 모드로 동작합니다.', err);
      return null;
    });
    return dbPromise;
  }

  function store(name, mode) {
    return openDb().then(function (db) {
      if (!db) return null;
      return db.transaction(name, mode).objectStore(name);
    });
  }

  function reqP(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function clone(v) {
    if (v == null) return v;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(v));
  }

  var api = {
    isMemoryMode: function () { return fallback; },

    open: openDb,

    all: function (name) {
      return store(name, 'readonly').then(function (s) {
        if (!s) return clone(Array.from(mem[name].values()));
        return reqP(s.getAll());
      });
    },

    get: function (name, key) {
      return store(name, 'readonly').then(function (s) {
        if (!s) return clone(mem[name].get(key));
        return reqP(s.get(key));
      });
    },

    put: function (name, value) {
      return store(name, 'readwrite').then(function (s) {
        if (!s) { mem[name].set(name === 'meta' ? value.k : value.key || value.id, clone(value)); return true; }
        return reqP(s.put(value)).then(function () { return true; });
      });
    },

    bulkPut: function (name, values) {
      if (!values || !values.length) return Promise.resolve(true);
      return store(name, 'readwrite').then(function (s) {
        if (!s) {
          values.forEach(function (v) { mem[name].set(name === 'meta' ? v.k : v.key || v.id, clone(v)); });
          return true;
        }
        var tx = s.transaction;
        values.forEach(function (v) { s.put(v); });
        return new Promise(function (resolve, reject) {
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error); };
        });
      });
    },

    del: function (name, key) {
      return store(name, 'readwrite').then(function (s) {
        if (!s) { mem[name].delete(key); return true; }
        return reqP(s.delete(key)).then(function () { return true; });
      });
    },

    clear: function (name) {
      return store(name, 'readwrite').then(function (s) {
        if (!s) { mem[name].clear(); return true; }
        return reqP(s.clear()).then(function () { return true; });
      });
    },

    getMeta: function (k) {
      return api.get('meta', k).then(function (row) { return row ? row.v : null; });
    },

    setMeta: function (k, v) {
      return api.put('meta', { k: k, v: v });
    },

    putBlob: function (key, blob) {
      return api.put('blobs', { key: key, blob: blob, t: Date.now() });
    },

    getBlob: function (key) {
      if (!key) return Promise.resolve(null);
      return api.get('blobs', key).then(function (row) { return row ? row.blob : null; });
    },

    delBlob: function (key) {
      if (!key) return Promise.resolve(true);
      return api.del('blobs', key);
    },

    blobKeys: function () {
      return api.all('blobs').then(function (rows) { return rows.map(function (r) { return r.key; }); });
    },

    blobRows: function () {
      return api.all('blobs').then(function (rows) {
        return rows.map(function (r) { return { key: r.key, t: r.t || 0 }; });
      });
    }
  };

  window.MemoIdb = api;
})();
