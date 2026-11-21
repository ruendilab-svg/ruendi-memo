/* ============================================================
 * store.js — 데이터 계층
 *  · 로컬(IndexedDB) 우선 저장
 *  · config.js 에 Supabase URL/키가 있으면 로그인(Auth) 후 클라우드 동기화
 *  · 로그인 전에는 메모를 메모리에 올리지 않고, 로그아웃하면 기기 캐시를 비운다
 *  · 병합 규칙: updated_at 이 더 최신인 쪽이 이김(마지막 쓰기 승리)
 * ============================================================ */
(function () {
  'use strict';

  var idb = window.MemoIdb;
  var CONFIG = window.MEMO_CONFIG || {};

  var memos = [];
  var byId = new Map();
  var listeners = new Set();
  var statusListeners = new Set();
  var authListeners = new Set();
  var client = null;
  var mode = 'local';
  var timer = null;
  var syncing = false;
  var lastPullWarn = false;
  var owner = '';           // 로그인한 user id (비공개 경로의 첫 폴더)
  var started = false;

  var status = { state: 'local', text: '로컬 모드', lastSync: null, error: null };
  var auth = { required: false, signedIn: false, email: '', user: null, error: null };

  /* ---------- 유틸 ---------- */

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(b) : (function () {
      for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    })();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  /* ---------- 링크 카테고리 ----------
   *  기본 4종은 항상 보이고, 사용자가 + 로 추가한 분류는 기기에 기억해 둔다.
   *  분류는 links 배열의 각 항목({ url, category })에 담긴다 → DB(links jsonb) 변경 없이 폰↔PC 동기화.
   */
  var LINK_CATEGORIES = ['패키지 관련', '레퍼런스', '디자인 정보', '기타 정보'];
  var DEFAULT_LINK_CATEGORY = '기타 정보';

  function linkCategoryName(cat) {
    var c = String(cat == null ? '' : cat).trim();
    return c || DEFAULT_LINK_CATEGORY;
  }

  function withCategories(list) {
    return (list || []).map(function (l) {
      return Object.assign({}, l, { url: normalizeUrl(l.url), category: linkCategoryName(l.category) });
    });
  }

  /* ---------- 링크 인식 ----------
   *  · https:// · http:// 로 시작하는 표준 주소
   *  · 프로토콜 없이 쓴 주소도 인식한다
   *      youtube.com/shorts/wIZIT00Q8Ls?si=…   www.naver.com   instagram.com/p/…   dedcool.com
   *  · 이메일(user@example.com) · 소수점(1.5, 2.0) · 파일명(logo.png, style.css) 은 링크가 아니다
   *      - 파일 확장자(png·jpg·css·js …)는 아래 TLD 목록에 없으므로 애초에 걸리지 않는다
   *      - TLD 목록에 없는 주소는 경로(/…, ?…)가 붙었을 때만 인정한다 → libfoo.so 같은 오인 방지
   *      - 도메인 바로 앞 글자가 영숫자·@·.·/·_·- 이면 주소가 아니다 → 이메일의 도메인 부분 차단
   */
  var HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  var PATH_TAIL = '[\\/?#][^\\s<>"\'`]*';
  var SAFE_TLDS = 'com|net|org|co\\.kr|kr|io|ai|app|dev|site|shop|store|info|biz|xyz|notion\\.site';
  var SAFE_DOMAIN = '(?:' + HOST_LABEL + '\\.)+(?:' + SAFE_TLDS + ')';
  var ANY_DOMAIN = '(?:' + HOST_LABEL + '\\.)+[a-z]{2,24}';
  var BARE_URL =
    '(?:(?:' + ANY_DOMAIN + ')(?::[0-9]{2,5})?' + PATH_TAIL +
    '|(?:' + SAFE_DOMAIN + ')(?::[0-9]{2,5})?(?:' + PATH_TAIL + ')?)';
  var URL_PREFIX = '[^0-9A-Za-z@\\/._\\-+]';
  var URL_RE = new RegExp(
    '(https?:\\/\\/[^\\s<>"\'`]+)' +
    '|((^|' + URL_PREFIX + ')(' + BARE_URL + '))',
    'gi'
  );
  var TAG_RE = /(^|[\s(\[{"'])#([0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\-]{1,30})/g;

  function stripUrls(text) {
    return String(text || '').replace(URL_RE, function (all, httpUrl, bare, prefix) {
      return prefix || ' ';
    });
  }

  function parseTags(text) {
    var src = stripUrls(text);
    var out = [];
    var seen = {};
    var m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
      var tag = m[2];
      var key = tag.toLowerCase();
      if (!seen[key]) { seen[key] = 1; out.push(tag); }
    }
    return out;
  }

  function trimUrl(u) {
    var s = String(u || '').replace(/[.,;:!?)}\]'"»…]+$/g, '');
    return s;
  }

  /* 프로토콜이 없으면 https:// 를 붙여 실제로 열리는 주소로 만든다 */
  function normalizeUrl(u) {
    var s = trimUrl(u);
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  /* 본문에서 링크 위치를 모두 찾는다 (본문 클릭 링크 렌더링에도 같은 규칙을 쓴다)
   *  → [{ start, end, raw, url }]  raw=본문에 쓰인 그대로, url=https:// 가 붙은 실제 주소 */
  function scanLinks(text) {
    var src = String(text || '');
    var out = [];
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(src)) !== null) {
      var raw = m[1] ? m[1] : m[4];
      var start = m[1] ? m.index : m.index + (m[3] ? m[3].length : 0);
      var trimmed = trimUrl(raw);
      if (!trimmed) { URL_RE.lastIndex = m.index + 1; continue; }
      out.push({ start: start, end: start + trimmed.length, raw: trimmed, url: normalizeUrl(trimmed) });
      URL_RE.lastIndex = start + trimmed.length;
    }
    return out;
  }

  function parseLinks(text) {
    var out = [];
    var seen = {};
    scanLinks(text).forEach(function (hit) {
      var key = hit.url.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ url: hit.url });
    });
    return out;
  }

  /* 저장된 links 가 본문과 어긋나면(프로토콜 없는 주소를 예전 버전으로 저장한 메모 등)
   * 본문에서 다시 뽑아낸다. 기존 항목의 부가 필드는 url 이 같으면 살려 둔다. */
  function linksFromContent(content, existing) {
    var parsed = parseLinks(content);
    var stored = Array.isArray(existing) ? existing.filter(function (l) { return l && l.url; }) : [];
    var normalized = stored.map(function (l) { return { url: normalizeUrl(l.url), item: l }; });
    var same = parsed.length === normalized.length && parsed.every(function (p, i) {
      return p.url === normalized[i].url;
    });
    if (same) {
      return stored.map(function (l) { return Object.assign({}, l, { url: normalizeUrl(l.url) }); });
    }
    var extraByUrl = {};
    normalized.forEach(function (n) {
      var extra = {};
      Object.keys(n.item).forEach(function (k) { if (k !== 'url') extra[k] = n.item[k]; });
      if (n.url) extraByUrl[n.url] = extra;
    });
    return parsed.map(function (p) { return Object.assign({}, extraByUrl[p.url] || {}, p); });
  }

  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function dateKey(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dateLabel(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + DAYS[d.getDay()] + '요일';
  }

  function timeLabel(iso) {
    var d = new Date(iso);
    var h = d.getHours();
    var ap = h < 12 ? '오전' : '오후';
    h = h % 12;
    if (h === 0) h = 12;
    return ap + ' ' + h + ':' + pad2(d.getMinutes());
  }

  var MemoUtil = {
    uuid: uuid,
    parseTags: parseTags,
    parseLinks: parseLinks,
    scanLinks: scanLinks,
    normalizeUrl: normalizeUrl,
    dateKey: dateKey,
    dateLabel: dateLabel,
    timeLabel: timeLabel,
    stripUrls: stripUrls,
    trimUrl: trimUrl,
    LINK_CATEGORIES: LINK_CATEGORIES,
    DEFAULT_LINK_CATEGORY: DEFAULT_LINK_CATEGORY,
    linkCategoryName: linkCategoryName
  };

  /* ---------- 상태 알림 ---------- */

  function emit() {
    var snapshot = memos.slice();
    listeners.forEach(function (fn) {
      try { fn(snapshot); } catch (e) { console.error(e); }
    });
  }

  function setStatus(patch) {
    status = Object.assign({}, status, patch);
    statusListeners.forEach(function (fn) {
      try { fn(status); } catch (e) { console.error(e); }
    });
  }

  function notifyAuth() {
    var snap = {
      required: auth.required,
      signedIn: auth.signedIn,
      email: auth.email,
      user: auth.user,
      error: auth.error
    };
    authListeners.forEach(function (fn) {
      try { fn(snap); } catch (e) { console.error(e); }
    });
  }

  function sortMemos() {
    memos.sort(function (a, b) {
      var ta = new Date(a.created_at).getTime();
      var tb = new Date(b.created_at).getTime();
      return ta === tb ? 0 : (ta < tb ? -1 : 1);
    });
    byId = new Map();
    memos.forEach(function (m) { byId.set(m.id, m); });
  }

  /* ---------- 레코드 변환 ---------- */

  function normalize(m) {
    m.content = typeof m.content === 'string' ? m.content : '';
    m.tags = Array.isArray(m.tags) && m.tags.length ? m.tags : parseTags(m.content);
    m.links = linksFromContent(m.content, m.links);
    m.links = withCategories(m.links);
    m.images = Array.isArray(m.images) ? m.images.filter(function (i) { return i && i.key; }) : [];
    m.pinned = !!m.pinned;
    m.deleted = !!m.deleted;
    if (!m.created_at) m.created_at = new Date().toISOString();
    if (!m.updated_at) m.updated_at = m.created_at;
    return m;
  }

  function fromRow(row) {
    return normalize({
      id: row.id,
      content: row.content || '',
      tags: row.tags || [],
      links: row.links || [],
      images: row.images || [],
      pinned: !!row.pinned,
      deleted: !!row.deleted,
      created_at: row.created_at,
      updated_at: row.updated_at,
      dirty: false
    });
  }

  function toRow(m) {
    var row = {
      id: m.id,
      content: m.content || '',
      tags: m.tags || [],
      links: m.links || [],
      images: m.images || [],
      pinned: !!m.pinned,
      deleted: !!m.deleted,
      created_at: m.created_at,
      updated_at: m.updated_at
    };
    if (owner) row.user_id = owner;   // RLS(auth.uid() = user_id)와 일치
    return row;
  }

  /* ---------- 초기화 ---------- */

  function cloudConfigured() {
    var url = String(CONFIG.supabaseUrl || '').trim();
    var key = String(CONFIG.supabaseAnonKey || '').trim();
    return /^https?:\/\//.test(url) && key.length >= 20;
  }

  function isCloud() { return mode === 'cloud'; }
  function authRequired() { return mode === 'cloud' && auth.required; }

  async function init() {
    var rows = [];

    if (cloudConfigured() && window.SbRest) {
      client = window.SbRest(
        CONFIG.supabaseUrl,
        CONFIG.supabaseAnonKey,
        CONFIG.table || 'memos',
        CONFIG.bucket || 'memo-images'
      );
      mode = 'cloud';
      auth.required = true;

      client.auth.onChange(function (session) {
        if (session) {
          auth.signedIn = true;
          auth.error = null;
          if (session.user) {
            auth.email = session.user.email || auth.email;
            auth.user = session.user;
          }
          notifyAuth();
        } else if (auth.signedIn) {
          handleAuthLost();
        }
      });

      var restored = null;
      try { restored = await client.auth.restore(); } catch (e) { restored = null; }

      if (restored) {
        await activateSession(restored);
      } else {
        auth.signedIn = false;
        auth.email = '';
        auth.user = null;
        memos = [];
        byId = new Map();
        setStatus({ state: 'signedout', text: '로그인 필요', lastSync: null, error: null });
        notifyAuth();
      }

      cleanupOrphanBlobs();
      emit();
      return memos;
    }

    // ----- 로컬 모드 (config 비어 있음) : 기존과 동일 -----
    try { rows = await idb.all('memos'); } catch (e) { console.warn(e); }
    memos = (rows || []).map(normalize);
    sortMemos();

    cleanupOrphanBlobs();

    mode = 'local';
    setStatus({ state: 'local', text: '로컬 모드' });

    emit();
    return memos;
  }

  /* 로그인 성공 → 계정 캐시 준비 후 동기화 시작 */
  async function activateSession(session) {
    owner = (session && session.user && session.user.id) || '';
    auth.required = true;
    auth.signedIn = true;
    auth.email = (session && session.user && session.user.email) || '';
    auth.user = (session && session.user) || null;
    auth.error = null;

    await isolateLocal(owner);

    var rows = [];
    try { rows = await idb.all('memos'); } catch (e) { console.warn(e); }
    memos = (rows || []).map(normalize);
    sortMemos();

    emit();
    notifyAuth();
    startCloudSync();
  }

  /* 기기 캐시 계정 격리
   *  · 같은 계정  → 그대로 사용
   *  · 다른 계정  → 이전 계정 캐시 삭제(섞임 방지)
   *  · 계정 없음(로컬 모드 데이터) → 처음 로그인한 계정으로 이관(업로드 대기)
   */
  async function isolateLocal(uid) {
    if (!uid) return;
    var stored = '';
    try { stored = (await idb.getMeta('owner')) || ''; } catch (e) { stored = ''; }
    if (stored === uid) return;

    if (!stored) {
      try {
        var rows = await idb.all('memos');
        if (rows && rows.length) {
          rows.forEach(function (r) { r.dirty = true; });
          await idb.bulkPut('memos', rows);
        }
        await idb.setMeta('lastPull', '');
      } catch (e) { /* ignore */ }
      try { await idb.setMeta('owner', uid); } catch (e) { /* ignore */ }
      return;
    }

    try { await idb.clear('memos'); } catch (e) { /* ignore */ }
    try {
      var keys = await idb.blobKeys();
      for (var i = 0; i < keys.length; i++) await idb.delBlob(keys[i]);
    } catch (e) { /* ignore */ }
    try { await idb.setMeta('lastPull', ''); } catch (e) { /* ignore */ }
    try { await idb.setMeta('owner', uid); } catch (e) { /* ignore */ }
  }

  function handleAuthLost() {
    stopCloudSync();
    auth.signedIn = false;
    auth.email = '';
    auth.user = null;
    owner = '';
    memos = [];
    byId = new Map();
    setStatus({ state: 'signedout', text: '로그인 필요', lastSync: null, error: null });
    emit();
    notifyAuth();
  }

  async function signIn(email, password, keepSignedIn) {
    if (!client) throw new Error('Supabase 설정(config.js)이 비어 있어요');
    auth.error = null;
    setStatus({ state: 'signing', text: '로그인 중…', error: null });
    var session;
    try {
      session = await client.auth.signIn(email, password, {
        persist: keepSignedIn === false ? 'session' : 'local'
      });
    } catch (e) {
      var msg = String((e && e.message) || e);
      auth.error = msg;
      setStatus({ state: 'signedout', text: '로그인 필요', error: msg });
      notifyAuth();
      throw e;
    }
    try {
      await activateSession(session);
    } catch (e) {
      setStatus({ state: 'error', text: '동기화 오류', error: String((e && e.message) || e) });
    }
    return session;
  }

  async function signOut() {
    stopCloudSync();
    try { if (client) await client.auth.signOut(); } catch (e) { /* ignore */ }

    // 로그아웃 시 기기 캐시 정리 (다음 로그인 때 서버에서 다시 내려받음)
    try { await idb.clear('memos'); } catch (e) { /* ignore */ }
    try {
      var keys = await idb.blobKeys();
      for (var i = 0; i < keys.length; i++) await idb.delBlob(keys[i]);
    } catch (e) { /* ignore */ }
    try { await idb.setMeta('lastPull', ''); } catch (e) { /* ignore */ }
    try { await idb.setMeta('owner', ''); } catch (e) { /* ignore */ }

    memos = [];
    byId = new Map();
    owner = '';
    auth.signedIn = false;
    auth.email = '';
    auth.user = null;
    setStatus({ state: 'signedout', text: '로그인 필요', lastSync: null, error: null });
    emit();
    notifyAuth();
  }

  /* 사진 첨부 후 전송하지 않고 닫힌 경우 등, 참조되지 않는 임시 blob 정리 */
  function cleanupOrphanBlobs() {
    var referenced = {};
    memos.forEach(function (m) {
      (m.images || []).forEach(function (img) { if (img.key) referenced[img.key] = 1; });
    });
    var cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2시간 지난 것만 (다른 탭 작업 보호)
    idb.blobRows().then(function (rows) {
      rows.forEach(function (r) {
        if (referenced[r.key]) return;
        if (r.t && r.t > cutoff) return;
        idb.delBlob(r.key).catch(function () {});
      });
    }).catch(function () {});
  }

  /* ---------- CRUD ---------- */

  var savingChain = Promise.resolve();
  function persist(m) {
    savingChain = savingChain.then(function () {
      return idb.put('memos', JSON.parse(JSON.stringify(m))).catch(function (e) { console.warn('[memo] save failed', e); });
    });
    return savingChain;
  }

  async function addMemo(input) {
    var now = new Date().toISOString();
    var content = String((input && input.content) || '');
    var category = linkCategoryName(input && input.linkCategory);
    var memo = normalize({
      id: uuid(),
      content: content,
      tags: parseTags(content),
      links: parseLinks(content).map(function (l) { return { url: l.url, category: category }; }),
      images: (input && input.images) || [],
      pinned: false,
      deleted: false,
      created_at: now,
      updated_at: now,
      dirty: true
    });
    memos.push(memo);
    byId.set(memo.id, memo);
    sortMemos();
    await persist(memo);
    emit();
    queuePush();
    return memo;
  }

  async function updateMemo(id, patch) {
    var m = byId.get(id);
    if (!m) return null;
    if (typeof patch.content === 'string') {
      m.content = patch.content;
      m.tags = parseTags(m.content);
      // 본문이 바뀌어도 이미 고른 링크 분류는 url 이 같은 한 유지한다
      m.links = withCategories(linksFromContent(m.content, m.links));
    }
    if (Array.isArray(patch.images)) m.images = patch.images;
    if (Array.isArray(patch.links)) m.links = withCategories(patch.links);
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    m.updated_at = new Date().toISOString();
    m.dirty = true;
    await persist(m);
    emit();
    queuePush();
    return m;
  }

  async function togglePin(id) {
    var m = byId.get(id);
    if (!m) return null;
    return updateMemo(id, { pinned: !m.pinned });
  }

  /* 링크 한 개(url 지정) 또는 메모의 모든 링크(url=null)의 분류를 바꿔 저장·동기화한다 */
  async function setLinkCategory(id, url, category) {
    var m = byId.get(id);
    if (!m) return null;
    var target = url ? normalizeUrl(url) : null;
    var next = linkCategoryName(category);
    var changed = false;
    var links = (m.links || []).map(function (l) {
      if (target && normalizeUrl(l.url) !== target) return l;
      if (linkCategoryName(l.category) === next) return l;
      changed = true;
      return Object.assign({}, l, { category: next });
    });
    if (!changed) return m;
    return updateMemo(id, { links: links });
  }

  async function deleteMemo(id) {
    var m = byId.get(id);
    if (!m) return false;
    m.deleted = true;
    m.pinned = false;
    m.updated_at = new Date().toISOString();
    m.dirty = true;
    await persist(m);

    var paths = [];
    for (var i = 0; i < (m.images || []).length; i++) {
      var img = m.images[i];
      if (img.path) paths.push(img.path);
      try { await idb.delBlob(img.key); } catch (e) { /* ignore */ }
    }
    if (client && auth.signedIn && paths.length) {
      client.remove(paths).catch(function (e) { console.warn('[memo] 스토리지 파일 삭제 실패', e); });
    }

    emit();
    queuePush();
    return true;
  }

  async function clearAll() {
    var now = new Date().toISOString();
    var paths = [];
    for (var i = 0; i < memos.length; i++) {
      var m = memos[i];
      if (m.deleted) continue;
      (m.images || []).forEach(function (img) { if (img.path) paths.push(img.path); });
      m.deleted = true;
      m.pinned = false;
      m.updated_at = now;
      m.dirty = true;
    }
    await idb.bulkPut('memos', memos.map(function (m) { return JSON.parse(JSON.stringify(m)); }));
    try {
      var keys = await idb.blobKeys();
      for (var k = 0; k < keys.length; k++) await idb.delBlob(keys[k]);
    } catch (e) { /* ignore */ }
    if (client && auth.signedIn && paths.length) {
      client.remove(paths).catch(function (e) { console.warn('[memo] 스토리지 파일 삭제 실패', e); });
    }
    emit();
    queuePush();
  }

  /* ---------- 동기화 ---------- */

  var pushTimer = null;
  function queuePush() {
    if (!client || !auth.signedIn) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      sync().catch(function () {});
    }, 800);
  }

  function extFor(type, name) {
    var t = String(type || '').toLowerCase();
    if (t.indexOf('png') !== -1) return '.png';
    if (t.indexOf('webp') !== -1) return '.webp';
    if (t.indexOf('gif') !== -1) return '.gif';
    if (t.indexOf('heic') !== -1) return '.heic';
    if (t.indexOf('jpeg') !== -1 || t.indexOf('jpg') !== -1) return '.jpg';
    var m = /\.([a-z0-9]{2,5})$/i.exec(String(name || ''));
    return m ? '.' + m[1].toLowerCase() : '.jpg';
  }

  async function push() {
    if (!owner) return;
    var dirty = memos.filter(function (m) { return m.dirty; });
    if (!dirty.length) return;

    // 1) 아직 클라우드에 없는 이미지 업로드 — 경로: <user_id>/<memo_id>/<filename>
    for (var i = 0; i < dirty.length; i++) {
      var m = dirty[i];
      var touched = false;
      for (var j = 0; j < (m.images || []).length; j++) {
        var img = m.images[j];
        if (img.path) continue;
        var blob = await idb.getBlob(img.key);
        if (!blob) continue;
        var path = owner + '/' + m.id + '/' + img.key + extFor(img.type, img.name);
        img.path = await client.upload(path, blob, img.type);
        img.url = '';            // 비공개 버킷이라 공개 URL 은 쓰지 않는다
        touched = true;
      }
      if (touched) {
        m.updated_at = new Date().toISOString();
        await persist(m);
      }
    }

    // 2) 레코드 upsert (100건씩)
    var rows = dirty.map(toRow);
    for (var s = 0; s < rows.length; s += 100) {
      await client.upsert(rows.slice(s, s + 100));
    }

    dirty.forEach(function (m) { m.dirty = false; });
    await idb.bulkPut('memos', dirty.map(function (m) { return JSON.parse(JSON.stringify(m)); }));
  }

  async function pull() {
    var last = await idb.getMeta('lastPull');
    var since = null;
    if (last) since = new Date(new Date(last).getTime() - 60000).toISOString();

    var rows;
    try {
      rows = await client.pull(since);
    } catch (e) {
      if (!lastPullWarn) {
        lastPullWarn = true;
        console.warn('[memo] pull 실패 — memo-app/supabase_setup.sql 을 먼저 실행했는지 확인하세요.', e);
      }
      throw e;
    }

    var changed = [];
    var dirtyKept = 0;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.id) continue;
      var local = byId.get(r.id);
      var remote = fromRow(r);
      if (!local) {
        memos.push(remote);
        byId.set(remote.id, remote);
        changed.push(remote);
      } else {
        var rTime = new Date(remote.updated_at || 0).getTime();
        var lTime = new Date(local.updated_at || 0).getTime();
        if (rTime > lTime) {
          Object.assign(local, remote, { dirty: false });
          changed.push(local);
        } else if (local.dirty) {
          dirtyKept++;
        }
      }
    }

    if (changed.length) {
      sortMemos();
      await idb.bulkPut('memos', changed.map(function (m) { return JSON.parse(JSON.stringify(m)); }));
      emit();
    }
    await idb.setMeta('lastPull', new Date().toISOString());
    if (dirtyKept) queuePush();
  }

  async function sync() {
    if (!client || !auth.signedIn) return;
    if (syncing) return;
    syncing = true;
    try {
      setStatus({ state: 'syncing', text: '동기화 중…', error: null });
      await push();
      await pull();
      // pull 도중 로컬이 더 최신이라 남겨진 변경이 있으면 한 번 더 올린다
      if (memos.some(function (m) { return m.dirty; })) await push();
      setStatus({ state: 'synced', text: '동기화됨', lastSync: new Date().toISOString(), error: null });
    } catch (e) {
      if (!auth.signedIn) throw e;   // 세션 만료 → 로그인 화면이 이미 안내한다
      setStatus({
        state: navigator.onLine ? 'error' : 'offline',
        text: navigator.onLine ? '동기화 오류' : '오프라인',
        error: String((e && e.message) || e)
      });
      throw e;
    } finally {
      syncing = false;
    }
  }

  function startCloudSync() {
    if (!client || !auth.signedIn) return;
    setStatus({ state: 'syncing', text: '동기화 중…', error: null });
    sync().catch(function () { /* status already set */ });

    var interval = Number(CONFIG.syncIntervalMs) || 8000;
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (!auth.signedIn) return;
      if (document.hidden) return;
      if (!navigator.onLine) { setStatus({ state: 'offline', text: '오프라인' }); return; }
      sync().catch(function () {});
    }, interval);

    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && navigator.onLine && auth.signedIn) sync().catch(function () {});
    });
    window.addEventListener('online', function () { if (auth.signedIn) sync().catch(function () {}); });
    window.addEventListener('offline', function () { setStatus({ state: 'offline', text: '오프라인' }); });
  }

  function stopCloudSync() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---------- 비공개 이미지 ---------- */

  /* 비공개 버킷에서 Bearer 토큰으로 내려받아 IndexedDB 에 캐시한다 */
  async function fetchImage(path, key) {
    if (!client || !path || !auth.signedIn) return null;
    try {
      var blob = await client.download(path);
      if (blob && key) {
        try { await idb.putBlob(key, blob); } catch (e) { /* ignore */ }
      }
      return blob;
    } catch (e) {
      console.warn('[memo] 비공개 이미지 내려받기 실패', e);
      return null;
    }
  }

  /* ---------- 내보내기 ---------- */

  function exportJson() {
    return {
      app: 'memo-app',
      version: 1,
      exported_at: new Date().toISOString(),
      memos: memos.filter(function (m) { return !m.deleted; }).map(toRow)
    };
  }

  window.MemoStore = {
    init: init,
    getMemos: function () { return memos.slice(); },
    getMemo: function (id) { return byId.get(id) || null; },
    addMemo: addMemo,
    updateMemo: updateMemo,
    togglePin: togglePin,
    setLinkCategory: setLinkCategory,
    deleteMemo: deleteMemo,
    clearAll: clearAll,
    subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
    onStatus: function (fn) { statusListeners.add(fn); return function () { statusListeners.delete(fn); }; },
    getStatus: function () { return status; },
    sync: sync,
    isCloud: isCloud,
    exportJson: exportJson,

    /* 인증 */
    authRequired: authRequired,
    getAuthState: function () {
      return { required: auth.required, signedIn: auth.signedIn, email: auth.email, user: auth.user, error: auth.error };
    },
    onAuth: function (fn) { authListeners.add(fn); return function () { authListeners.delete(fn); }; },
    signIn: signIn,
    signOut: signOut,
    fetchImage: fetchImage,
    getOwner: function () { return owner; }
  };

  window.MemoUtil = MemoUtil;
})();
