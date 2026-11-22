/* ============================================================
 * app.js — 카톡 '나와의 채팅' 스타일 레퍼런스 메모장 UI
 * ============================================================ */
(function () {
  'use strict';

  var Store = window.MemoStore;
  var idb = window.MemoIdb;
  var U = window.MemoUtil;
  var APP_VERSION = '1.3.0';
  window.__appVersion = APP_VERSION;   // index.html 의 버전 가드가 비교하는 값

  var SET_KEY = 'memo.settings.v1';
  var PIN_KEY = 'memo.pin.v1';
  var LINK_CAT_KEY = 'memo.linkcats.v1';
  var PHOTO_CAT_KEY = 'memo.photocats.v1';
  var MEMO_CAT_KEY = 'memo.memocats.v1';

  /* 분류별 아이콘 — 말풍선·사진 탭·링크 탭·메모 탭에서 같은 표기를 쓴다 */
  var CAT_ICONS = {
    '패키지 관련': '📦',
    '레퍼런스': '🎨',
    '디자인 정보': '💡',
    '기타 정보': '📌',
    '일반': '📝',
    '시그스튜디오대본': '🎬'
  };

  function catIcon(cat) { return CAT_ICONS[cat] || '📁'; }
  function catBadgeText(cat) { return catIcon(cat) + ' ' + cat; }

  var els = {};
  var blobUrls = new Map();
  var state = {
    memos: [],
    view: 'photos',
    tag: null,
    linkCat: null,
    photoCat: null,
    memoCat: null,
    composerCat: null,
    composerPhotoCat: null,
    composerMemoCat: null,
    customCats: loadCustomCats(),
    photoCustomCats: loadPhotoCats(),
    memoCustomCats: loadMemoCats(),
    query: '',
    searchOpen: true,
    pending: [],
    lightbox: null,
    editingId: null,
    sending: false,
    dragDepth: 0,
    settings: loadSettings(),
    pinBuffer: '',
    pinFails: 0,
    pinLockUntil: 0,
    unlocked: false,
    settingsOpen: false,
    installEvent: null
  };

  /* ---------------------------------------------------------- */
  /* 작은 도우미                                                */
  /* ---------------------------------------------------------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function loadSettings() {
    var base = { imageQuality: 'optimized', shiftEnterSend: true, autoLockMin: 3 };
    try {
      var raw = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
      return Object.assign(base, raw || {});
    } catch (e) { return base; }
  }

  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------- */
  /* 링크 분류 (패키지 관련 · 레퍼런스 · 디자인 정보 · 기타 정보)   */
  /* ---------------------------------------------------------- */

  function defaultLinkCategories() {
    return (U.LINK_CATEGORIES || ['패키지 관련', '레퍼런스', '디자인 정보', '기타 정보']).slice();
  }

  function defaultLinkCategory() {
    return U.DEFAULT_LINK_CATEGORY || '기타 정보';
  }

  function loadCustomCats() {
    try {
      var arr = JSON.parse(localStorage.getItem(LINK_CAT_KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string' && x.trim(); })
        .map(function (x) { return x.trim(); });
    } catch (e) { return []; }
  }

  function saveCustomCats() {
    try { localStorage.setItem(LINK_CAT_KEY, JSON.stringify(state.customCats)); } catch (e) { /* ignore */ }
  }

  /* 기본 4종 → 직접 추가한 분류 → 이미 메모에 저장된 분류 순서로 중복 없이 */
  function linkCategories() {
    var out = [];
    var seen = {};
    defaultLinkCategories().forEach(function (c) {
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    (state.customCats || []).forEach(function (c) {
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    state.memos.forEach(function (m) {
      if (m.deleted) return;
      (m.links || []).forEach(function (l) {
        var c = l && l.category;
        if (c && !seen[c]) { seen[c] = 1; out.push(c); }
      });
    });
    return out;
  }

  function linkCategoryOf(link) {
    return (link && link.category) || defaultLinkCategory();
  }

  function categoryCounts(items) {
    var map = new Map();
    items.forEach(function (it) {
      var c = linkCategoryOf(it.link);
      map.set(c, (map.get(c) || 0) + 1);
    });
    return map;
  }

  function addLinkCategory() {
    var name = window.prompt('추가할 링크 분류 이름을 입력하세요');
    if (name === null) return null;
    name = name.trim();
    if (!name) return null;
    if (linkCategories().indexOf(name) !== -1) { toast('이미 있는 분류예요'); return name; }
    state.customCats.push(name);
    saveCustomCats();
    toast("'" + name + "' 분류를 추가했어요");
    render();
    return name;
  }

  /* 입력창에 주소가 감지되면 위에 분류 선택 바를 띄운다 */
  function renderLinkCatBar() {
    if (!els.linkCatBar) return;
    els.linkCatBar.innerHTML = '';
    var current = state.composerCat || defaultLinkCategory();
    els.linkCatBar.appendChild(el('span', 'ts-label', '분류'));
    linkCategories().forEach(function (cat) {
      var b = el('button', 'chip small' + (cat === current ? ' active' : ''), cat);
      b.type = 'button';
      b.setAttribute('data-cat', cat);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        state.composerCat = cat;
        renderLinkCatBar();
      });
      els.linkCatBar.appendChild(b);
    });
    var add = el('button', 'chip small add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', '링크 분류 추가');
    add.title = '분류 추가';
    add.addEventListener('mousedown', function (e) { e.preventDefault(); });
    add.addEventListener('click', function () {
      var name = addLinkCategory();
      if (name) state.composerCat = name;
      renderLinkCatBar();
    });
    els.linkCatBar.appendChild(add);
  }

  function updateLinkCatBar() {
    if (!els.linkCatBar) return;
    // 📝 메모 탭에서는 주소를 링크로 뽑지 않으므로 링크 분류 바를 띄우지 않는다
    var hasLink = state.view !== 'memo' && !!(els.input && U.parseLinks(els.input.value).length);
    if (!hasLink) {
      state.composerCat = null;
      els.linkCatBar.innerHTML = '';
      els.linkCatBar.classList.add('hidden');
      return;
    }
    renderLinkCatBar();
    els.linkCatBar.classList.remove('hidden');
  }

  /* ---------------------------------------------------------- */
  /* 사진 분류 (링크와 같은 4분류, images[].category 에 저장)      */
  /* ---------------------------------------------------------- */

  function defaultPhotoCategories() { return defaultLinkCategories(); }

  function loadPhotoCats() {
    try {
      var arr = JSON.parse(localStorage.getItem(PHOTO_CAT_KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string' && x.trim(); })
        .map(function (x) { return x.trim(); });
    } catch (e) { return []; }
  }

  function savePhotoCats() {
    try { localStorage.setItem(PHOTO_CAT_KEY, JSON.stringify(state.photoCustomCats)); } catch (e) { /* ignore */ }
  }

  /* 기본 4종 → 사진용으로 추가한 분류 → 이미 저장된 사진에 붙은 분류 순서로 중복 없이 */
  function photoCategories() {
    var out = [];
    var seen = {};
    defaultPhotoCategories().forEach(function (c) {
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    (state.photoCustomCats || []).forEach(function (c) {
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    state.memos.forEach(function (m) {
      if (m.deleted) return;
      (m.images || []).forEach(function (img) {
        var c = photoCategoryOf(img);
        if (c && !seen[c]) { seen[c] = 1; out.push(c); }
      });
    });
    return out;
  }

  function photoCategoryOf(img) {
    return (img && img.category) || defaultLinkCategory();
  }

  function photoCategoryCounts(items) {
    var map = new Map();
    items.forEach(function (it) {
      var c = photoCategoryOf(it.img);
      map.set(c, (map.get(c) || 0) + 1);
    });
    return map;
  }

  function addPhotoCategory() {
    var name = window.prompt('추가할 사진 분류 이름을 입력하세요');
    if (name === null) return null;
    name = name.trim();
    if (!name) return null;
    if (photoCategories().indexOf(name) !== -1) { toast('이미 있는 분류예요'); return name; }
    state.photoCustomCats.push(name);
    savePhotoCats();
    toast("'" + name + "' 분류를 추가했어요");
    render();
    return name;
  }

  /* 직접 추가한 분류가 0건이면 길게 눌러(또는 우클릭, 칩 안 ✕) 지울 수 있다 */
  function attachCatChipOps(chip, kind, cat, count) {
    if (!cat || count > 0) return;
    var custom = ({ link: state.customCats, photo: state.photoCustomCats, memo: state.memoCustomCats })[kind] || [];
    if (custom.indexOf(cat) !== -1) {
      var x = el('span', 'chip-x', '✕');
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', '빈 분류 삭제');
      x.title = '이 분류 지우기';
      x.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        removeCategory(kind, cat);
      });
      chip.appendChild(x);
    }
    var timer = null;
    var fired = false;
    chip.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      fired = false;
      clearTimeout(timer);
      timer = setTimeout(function () { fired = true; removeCategory(kind, cat); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(function (ev) {
      chip.addEventListener(ev, function () { clearTimeout(timer); });
    });
    chip.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      removeCategory(kind, cat);
    });
    chip.addEventListener('click', function (e) {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
  }

  function removeCategory(kind, cat) {
    var lists = { link: state.customCats, photo: state.photoCustomCats, memo: state.memoCustomCats };
    var saves = { link: saveCustomCats, photo: savePhotoCats, memo: saveMemoCats };
    var list = lists[kind];
    if (!list) return;
    var i = list.indexOf(cat);
    if (i === -1) { toast('기본 분류는 지울 수 없어요'); return; }
    if (!window.confirm("'" + cat + "' 분류를 지울까요?\n(이 분류에 항목이 0건일 때만 지울 수 있어요)")) return;
    list.splice(i, 1);
    saves[kind]();
    toast("'" + cat + "' 분류를 지웠어요");
    updateLinkCatBar();
    updatePhotoCatBar();
    updateMemoCatBar();
    render();
  }

  function catChipBtn(cat, current, onPick) {
    var b = el('button', 'chip small' + (cat === current ? ' active' : ''), cat);
    b.type = 'button';
    b.setAttribute('data-cat', cat);
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () { onPick(cat); });
    return b;
  }

  function renderPhotoCatBar() {
    if (!els.photoCatBar) return;
    els.photoCatBar.innerHTML = '';
    var current = state.composerPhotoCat || defaultLinkCategory();
    els.photoCatBar.appendChild(el('span', 'ts-label', '🖼️ 사진'));
    photoCategories().forEach(function (cat) {
      els.photoCatBar.appendChild(catChipBtn(cat, current, function (picked) {
        state.composerPhotoCat = picked;
        renderPhotoCatBar();
      }));
    });
    var add = el('button', 'chip small add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', '사진 분류 추가');
    add.title = '분류 추가';
    add.addEventListener('mousedown', function (e) { e.preventDefault(); });
    add.addEventListener('click', function () {
      var name = addPhotoCategory();
      if (name) state.composerPhotoCat = name;
      renderPhotoCatBar();
    });
    els.photoCatBar.appendChild(add);
  }

  /* 사진을 첨부한 동안에만 입력창 위에 사진 분류 바를 보여 준다 */
  function updatePhotoCatBar() {
    if (!els.photoCatBar) return;
    if (!state.pending.length) {
      state.composerPhotoCat = null;
      els.photoCatBar.innerHTML = '';
      els.photoCatBar.classList.add('hidden');
      return;
    }
    if (!state.composerPhotoCat) state.composerPhotoCat = defaultLinkCategory();
    renderPhotoCatBar();
    els.photoCatBar.classList.remove('hidden');
  }

  /* ---------------------------------------------------------- */
  /* 📝 메모 분류 (사진도 링크도 없는 글자 메모 전용)              */
  /*  · DB 스키마 변경 없이 tags 배열의 '__mcat:<분류>' 마커로 동기화  */
  /* ---------------------------------------------------------- */

  function memoCatPrefix() { return U.MEMO_CAT_PREFIX || '__mcat:'; }

  function memoCategoryOfMemo(m) {
    return U.memoCategoryOf ? U.memoCategoryOf(m) : '';
  }

  function defaultMemoCategory() { return U.DEFAULT_MEMO_CATEGORY || '일반'; }

  /* 분류를 고르지 않은 글자 메모는 '일반'으로 센다 */
  function memoCategoryName(m) { return memoCategoryOfMemo(m) || defaultMemoCategory(); }

  function visibleTagsOf(m) {
    var tags = (m && m.tags) || [];
    if (U.visibleTags) return U.visibleTags(tags);
    return tags.filter(function (t) { return String(t).indexOf(memoCatPrefix()) !== 0; });
  }

  function defaultMemoCategories() { return ['일반', '시그스튜디오대본']; }

  function loadMemoCats() {
    try {
      var arr = JSON.parse(localStorage.getItem(MEMO_CAT_KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string' && x.trim(); })
        .map(function (x) { return x.trim(); });
    } catch (e) { return []; }
  }

  function saveMemoCats() {
    try { localStorage.setItem(MEMO_CAT_KEY, JSON.stringify(state.memoCustomCats)); } catch (e) { /* ignore */ }
  }

  /* 기본 2종(일반·시그스튜디오대본) → 직접 추가한 분류 → 이미 저장된 메모 분류 순서로 중복 없이 */
  function memoCategoryList() {
    var out = [];
    var seen = {};
    var push = function (cat) {
      if (cat && !seen[cat]) { seen[cat] = 1; out.push(cat); }
    };
    defaultMemoCategories().forEach(push);
    (state.memoCustomCats || []).forEach(push);
    state.memos.forEach(function (m) {
      if (m.deleted) return;
      if ((m.images || []).length) return;
      if ((m.links || []).length) return;
      push(memoCategoryOfMemo(m));
    });
    return out;
  }

  function memoCategoryCounts(list) {
    var map = new Map();
    list.forEach(function (m) {
      var c = memoCategoryName(m);
      map.set(c, (map.get(c) || 0) + 1);
    });
    return map;
  }

  function addMemoCategory() {
    var name = window.prompt('추가할 메모 분류 이름을 입력하세요');
    if (name === null) return null;
    name = name.trim();
    if (!name) return null;
    if (memoCategoryList().indexOf(name) !== -1) { toast('이미 있는 분류예요'); return name; }
    state.memoCustomCats.push(name);
    saveMemoCats();
    toast("'" + name + "' 분류를 추가했어요");
    render();
    return name;
  }

  /* 📝 메모 탭 상단 카테고리 칩 줄 */
  function renderMemoCatRow(list) {
    if (!els.memoCatRow) return;
    els.memoCatRow.innerHTML = '';
    var counts = memoCategoryCounts(list);
    var chipFor = function (label, cat, count) {
      var active = cat === null ? !state.memoCat : state.memoCat === cat;
      var b = el('button', 'chip' + (active ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('data-cat', cat === null ? '' : cat);
      b.appendChild(document.createTextNode(label));
      b.appendChild(el('span', 'chip-count', String(count)));
      b.addEventListener('click', function () {
        state.memoCat = (cat === null || active) ? null : cat;
        render();
      });
      attachCatChipOps(b, 'memo', cat, count);
      return b;
    };
    els.memoCatRow.appendChild(chipFor('전체', null, list.length));
    memoCategoryList().forEach(function (cat) {
      els.memoCatRow.appendChild(chipFor(cat, cat, counts.get(cat) || 0));
    });
    var add = el('button', 'chip add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', '메모 분류 추가');
    add.title = '분류 추가';
    add.addEventListener('click', function () { addMemoCategory(); });
    els.memoCatRow.appendChild(add);
  }

  /* 입력창 위 메모 분류 바 — 📝 메모 탭에서만 보인다 */
  function renderMemoCatBar() {
    if (!els.memoCatBar) return;
    els.memoCatBar.innerHTML = '';
    var current = state.composerMemoCat || defaultMemoCategory();
    els.memoCatBar.appendChild(el('span', 'ts-label', '📝 메모'));
    memoCategoryList().forEach(function (cat) {
      var b = el('button', 'chip small' + (cat === current ? ' active' : ''), cat);
      b.type = 'button';
      b.setAttribute('data-cat', cat);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        state.composerMemoCat = cat;
        renderMemoCatBar();
      });
      els.memoCatBar.appendChild(b);
    });
    var add = el('button', 'chip small add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', '메모 분류 추가');
    add.title = '분류 추가';
    add.addEventListener('mousedown', function (e) { e.preventDefault(); });
    add.addEventListener('click', function () {
      var name = addMemoCategory();
      if (name) state.composerMemoCat = name;
      renderMemoCatBar();
    });
    els.memoCatBar.appendChild(add);
  }

  function updateMemoCatBar() {
    if (!els.memoCatBar) return;
    if (state.view !== 'memo') {
      state.composerMemoCat = null;
      els.memoCatBar.innerHTML = '';
      els.memoCatBar.classList.add('hidden');
      return;
    }
    renderMemoCatBar();
    els.memoCatBar.classList.remove('hidden');
  }

  /* 📝 메모 탭에 보이는 메모 = 사진도 링크도 없는 글자 메모 */
  function isMemoTabMemo(m) {
    return !(m.images || []).length && !(m.links || []).length;
  }

  function getPin() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch (e) { return null; }
  }

  function setPinData(data) {
    try {
      if (!data) localStorage.removeItem(PIN_KEY);
      else localStorage.setItem(PIN_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  function randomHex(len) {
    var b = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
    else for (var i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function hashPin(pin, salt) {
    var data = new TextEncoder().encode(salt + ':' + pin);
    return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  var toastTimer = null;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 1900);
  }

  function isNearBottom() {
    var s = els.scroller;
    if (!s) return true;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 180;
  }

  function scrollToBottom(smooth) {
    var s = els.scroller;
    if (!s) return;
    if (smooth && 'scrollBehavior' in document.documentElement.style) {
      s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
    } else {
      s.scrollTop = s.scrollHeight;
    }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }

  function shortDate(iso) {
    var d = new Date(iso);
    var now = new Date();
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
    return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '.';
  }

  /* ---------------------------------------------------------- */
  /* 이미지: 불러오기 / 압축 / 미리보기                          */
  /* ---------------------------------------------------------- */

  function objectUrlFor(blob, key) {
    var u = URL.createObjectURL(blob);
    if (key) blobUrls.set(key, u);
    return u;
  }

  function resolveImage(img) {
    if (!img) return Promise.resolve('');
    var key = img.key;
    if (key && blobUrls.has(key)) return Promise.resolve(blobUrls.get(key));

    var cached = key ? idb.getBlob(key).catch(function () { return null; }) : Promise.resolve(null);
    return cached.then(function (blob) {
      if (blob) return objectUrlFor(blob, key);
      // 비공개 버킷(memo-images)은 Bearer 토큰으로 내려받아 캐시한다
      if (img.path && Store.fetchImage) {
        return Store.fetchImage(img.path, key).then(function (b) {
          if (b) return objectUrlFor(b, key);
          return img.url || '';
        }).catch(function () { return img.url || ''; });
      }
      return img.url || '';
    }).catch(function () { return img.url || ''; });
  }

  function hydrateImages() {
    var nodes = $$('img[data-key]:not([data-loaded])');
    if (!nodes.length) return;
    nodes.forEach(function (elImg) {
      elImg.setAttribute('data-loaded', '1');
      var key = elImg.getAttribute('data-key');
      var remote = elImg.getAttribute('data-url') || '';
      var path = elImg.getAttribute('data-path') || '';
      resolveImage({ key: key, url: remote, path: path }).then(function (url) {
        if (url) {
          elImg.src = url;
          elImg.classList.remove('loading');
        } else {
          elImg.classList.add('missing');
        }
      });
    });
  }

  function compressImage(file) {
    var quality = state.settings.imageQuality;
    if (quality !== 'optimized' || !file.type || file.type.indexOf('image/') !== 0) {
      return Promise.resolve({ blob: file, w: 0, h: 0 });
    }
    if (typeof createImageBitmap !== 'function') return Promise.resolve({ blob: file, w: 0, h: 0 });

    return createImageBitmap(file).then(function (bmp) {
      var w0 = bmp.width, h0 = bmp.height;
      var maxSide = 1600;
      var scale = Math.min(1, maxSide / Math.max(w0, h0));
      var smallEnough = scale >= 1 && file.size < 700 * 1024;

      if (smallEnough) {
        if (bmp.close) bmp.close();
        return { blob: file, w: w0, h: h0 };
      }

      var w = Math.max(1, Math.round(w0 * scale));
      var h = Math.max(1, Math.round(h0 * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();

      return new Promise(function (resolve) {
        canvas.toBlob(function (out) {
          if (out && out.size < file.size) resolve({ blob: out, w: w, h: h });
          else resolve({ blob: file, w: w0, h: h0 });
        }, 'image/jpeg', 0.82);
      });
    }).catch(function () {
      return { blob: file, w: 0, h: 0 };
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) {
      if (fileList && fileList.length) toast('이미지 파일만 첨부할 수 있어요');
      return;
    }
    var room = 20 - state.pending.length;
    if (room <= 0) { toast('사진은 한 번에 20장까지 첨부할 수 있어요'); return; }
    if (files.length > room) toast('20장까지만 첨부했어요');

    var queue = files.slice(0, room);
    var chain = Promise.resolve();
    queue.forEach(function (file) {
      chain = chain.then(function () {
        return compressImage(file).then(function (r) {
          var key = U.uuid();
          return idb.putBlob(key, r.blob).then(function () {
            state.pending.push({
              key: key,
              w: r.w,
              h: r.h,
              type: r.blob.type || file.type,
              size: r.blob.size,
              name: file.name || ('photo-' + (state.pending.length + 1) + '.jpg'),
              previewUrl: URL.createObjectURL(r.blob)
            });
            renderPending();
          });
        });
      }).catch(function (err) { console.warn('[memo] attach failed', err); });
    });
    chain.then(function () {
      if (state.pending.length) toast(state.pending.length + '장 첨부 · 전송을 누르세요');
    });
  }

  function removePending(index) {
    var p = state.pending[index];
    if (!p) return;
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    idb.delBlob(p.key).catch(function () {});
    state.pending.splice(index, 1);
    renderPending();
  }

  function renderPending() {
    if (!els.pendingTray) return;
    els.pendingTray.innerHTML = '';
    if (!state.pending.length) {
      els.pendingTray.classList.add('hidden');
      updatePhotoCatBar();
      autoGrow();
      return;
    }
    els.pendingTray.classList.remove('hidden');
    state.pending.forEach(function (p, i) {
      var box = el('div', 'pending-item');
      var img = document.createElement('img');
      img.src = p.previewUrl;
      img.alt = '';
      var x = el('button', 'pending-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', '첨부 취소');
      x.addEventListener('click', function () { removePending(i); });
      box.appendChild(img);
      box.appendChild(x);
      els.pendingTray.appendChild(box);
    });
    var info = el('div', 'pending-info',
      state.pending.length + '장 · ' + (state.settings.imageQuality === 'optimized' ? '웹 최적화' : '원본 유지'));
    els.pendingTray.appendChild(info);
    updatePhotoCatBar();
    autoGrow();   // 글자 없이 사진만 첨부해도 전송 버튼이 열리도록
  }

  /* ---------------------------------------------------------- */
  /* 렌더링                                                     */
  /* ---------------------------------------------------------- */

  function filteredMemos() {
    var q = state.query.trim().toLowerCase();
    var tag = state.tag ? state.tag.toLowerCase() : null;

    return state.memos.filter(function (m) {
      if (m.deleted) return false;
      if (tag && !(m.tags || []).some(function (t) { return String(t).toLowerCase() === tag; })) return false;
      if (!q) return true;
      var hay = [m.content, (m.tags || []).join(' '), (m.links || []).map(function (l) { return l.url; }).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* 태그 집계 — list 를 주면 그 메모들만 (📝 메모 탭 상단 필터), 없으면 전체 (입력창 자동완성) */
  function tagCounts(list) {
    var map = new Map();
    (list || state.memos).forEach(function (m) {
      if (m.deleted) return;
      visibleTagsOf(m).forEach(function (t) {
        var key = String(t).toLowerCase();
        var item = map.get(key);
        if (item) item.count++;
        else map.set(key, { name: t, count: 1 });
      });
    });
    return Array.from(map.values()).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return String(a.name).localeCompare(String(b.name), 'ko');
    });
  }

  function renderTagbar(memoOnly) {
    if (!els.tagbar) return;
    els.tagbar.innerHTML = '';

    /* 사진·링크 탭은 각 탭의 분류 칩 줄(#photoCatBar / #linkCatBar 의 카테고리 칩)을 이미 갖고 있다.
     * 상단 태그 필터 바까지 뜨면 두 줄이 겹쳐 보이므로, 📝 메모 탭에서만 상단 바를 그린다.
     * (메모 탭 상단 = 메모 카테고리 칩 줄 + 그 아래 태그 필터 줄) */
    if (state.view !== 'memo') {
      if (els.memoCatRow) els.memoCatRow.innerHTML = '';
      els.tagbarWrap.classList.add('hidden');
      return;
    }

    renderMemoCatRow(memoOnly || []);

    var tags = tagCounts(memoOnly || []);

    var all = el('button', 'chip' + (state.tag === null ? ' active' : ''), '전체');
    all.type = 'button';
    all.addEventListener('click', function () {
      state.tag = null;
      render();
    });
    els.tagbar.appendChild(all);

    tags.forEach(function (t) {
      var active = state.tag && state.tag.toLowerCase() === String(t.name).toLowerCase();
      var chip = el('button', 'chip' + (active ? ' active' : ''));
      chip.type = 'button';
      chip.appendChild(document.createTextNode('#' + t.name));
      chip.appendChild(el('span', 'chip-count', String(t.count)));
      chip.addEventListener('click', function () {
        state.tag = active ? null : t.name;
        render();
      });
      els.tagbar.appendChild(chip);
    });

    els.tagbar.classList.toggle('hidden', tags.length === 0);
    els.tagbarWrap.classList.remove('hidden');
  }

  /* 본문 안의 주소를 클릭 링크로 바꾼다.
   * store.js 의 scanLinks 를 그대로 쓰므로 링크 카드·🔗 링크 탭과 판정 규칙이 같다
   * (https:// 없는 youtube.com/shorts/…, www.naver.com, dedcool.com 도 링크가 된다) */
  function appendRichText(container, text) {
    var src = String(text || '');
    var hits = U.scanLinks ? U.scanLinks(src) : [];
    var last = 0;

    hits.forEach(function (hit) {
      if (hit.start > last) appendTaggedText(container, src.slice(last, hit.start));
      var a = el('a', 'inline-link', hit.raw);
      a.href = hit.url;          // 프로토콜이 없던 주소는 https:// 가 붙어 있다
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.appendChild(a);
      last = hit.end;
    });
    if (last < src.length) appendTaggedText(container, src.slice(last));
  }

  function appendTaggedText(container, text) {
    var tagRe = /#([0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\-]{1,30})/g;
    var last = 0;
    var m;
    while ((m = tagRe.exec(text)) !== null) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      var span = el('span', 'tag-text', '#' + m[1]);
      container.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  function imageGrid(m) {
    var imgs = (m.images || []).slice(0, 9);
    var wrap = el('div', 'img-grid n' + Math.min(imgs.length, 3));
    if (imgs.length === 1) wrap.classList.add('single');

    imgs.forEach(function (img, idx) {
      var cell = el('div', 'cell');
      var image = document.createElement('img');
      image.alt = '첨부 사진';
      image.loading = 'lazy';
      image.className = 'loading';
      image.setAttribute('data-key', img.key || '');
      if (img.url) image.setAttribute('data-url', img.url);
      if (img.path) image.setAttribute('data-path', img.path);
      image.addEventListener('click', function () { openLightbox(m, idx); });
      cell.appendChild(image);
      if (idx === 8 && m.images.length > 9) {
        cell.appendChild(el('div', 'more-count', '+' + (m.images.length - 9)));
      }
      wrap.appendChild(cell);
    });
    return wrap;
  }

  function faviconEl(url, cls) {
    var host = hostOf(url);
    var letter = (host.replace(/^[^0-9a-z가-힣]+/i, '')[0] || '🔗').toUpperCase();
    var span = el('span', cls, letter);
    var hue = 0;
    for (var i = 0; i < host.length; i++) hue = (hue * 31 + host.charCodeAt(i)) % 360;
    span.style.background = 'hsl(' + hue + ', 52%, 60%)';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  /* ---------------------------------------------------------- */
  /* 유튜브 카드: 썸네일 + 영상 제목                              */
  /*  · 썸네일은 i.ytimg.com 에서 바로 (실패하면 파비콘 카드로)     */
  /*  · 제목은 oEmbed 를 비동기로 받아 메모리·localStorage 에 캐시  */
  /* ---------------------------------------------------------- */

  var YT_META_KEY = 'memo.ytmeta.v1';
  var YT_META_TTL = 1000 * 60 * 60 * 24 * 30;  // 30일 지나면 제목을 조용히 새로 받아 온다
  var YT_META_MAX = 400;
  var ytMeta = null;
  var ytPending = {};
  var ytFailed = {};

  function loadYtMeta() {
    if (ytMeta) return ytMeta;
    ytMeta = {};
    try {
      var raw = JSON.parse(localStorage.getItem(YT_META_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (id) {
          var it = raw[id];
          if (it && typeof it.title === 'string' && it.title) ytMeta[id] = it;
        });
      }
    } catch (e) { ytMeta = {}; }
    return ytMeta;
  }

  function saveYtMeta() {
    try {
      var keys = Object.keys(ytMeta);
      if (keys.length > YT_META_MAX) {
        keys.sort(function (a, b) { return (ytMeta[a].at || 0) - (ytMeta[b].at || 0); });
        keys.slice(0, keys.length - YT_META_MAX).forEach(function (k) { delete ytMeta[k]; });
      }
      localStorage.setItem(YT_META_KEY, JSON.stringify(ytMeta));
    } catch (e) { /* 저장 공간이 없으면 캐시 없이 동작 */ }
  }

  function youtubeMetaOf(id) {
    var m = loadYtMeta()[id];
    return m && m.title ? m : null;
  }

  function applyYouTubeTitle(id, title) {
    if (!title) return;
    var cards = document.querySelectorAll('[data-yt-id="' + id + '"]');
    Array.prototype.forEach.call(cards, function (card) {
      var node = card.querySelector('.yt-title');
      if (node) node.textContent = title;
      card.classList.add('has-title');
    });
  }

  /* 영상 제목을 받아 온다. 실패(오프라인·차단·삭제 영상)하면 조용히 포기한다. */
  function requestYouTubeTitle(id) {
    if (!id) return null;
    if (ytPending[id]) return ytPending[id];

    var cached = youtubeMetaOf(id);
    if (cached && !(cached.at && Date.now() - cached.at > YT_META_TTL)) return null;
    if (!cached && ytFailed[id]) return null;

    var endpoint = 'https://www.youtube.com/oembed?url=' +
      encodeURIComponent(U.youtubeWatchUrl(id)) + '&format=json';
    var p = fetch(endpoint, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('oembed ' + (res && res.status));
        return res.json();
      })
      .then(function (data) {
        var title = String((data && data.title) || '').replace(/\s+/g, ' ').trim();
        if (!title) throw new Error('no title');
        ytMeta[id] = {
          title: title.slice(0, 200),
          author: String((data && data.author_name) || '').slice(0, 80),
          at: Date.now()
        };
        saveYtMeta();
        applyYouTubeTitle(id, ytMeta[id].title);
        return ytMeta[id];
      })
      .catch(function () {
        ytFailed[id] = 1;
        return null;
      });
    ytPending[id] = p;
    p.then(function () { delete ytPending[id]; });
    return p;
  }

  function youtubeThumbEl(id) {
    var wrap = el('span', 'yt-thumb');
    var img = document.createElement('img');
    img.className = 'yt-thumb-img';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = U.youtubeThumb(id);
    wrap.appendChild(img);
    wrap.appendChild(el('span', 'yt-play', '▶'));
    return wrap;
  }

  /* 썸네일이 안 뜨면 썸네일을 걷어내고 원래의 파비콘 카드 모양으로 되돌린다 */
  function fallbackToFavicon(a, thumb, url, kind) {
    var done = false;
    var img = thumb.querySelector('img');
    if (!img) return;
    img.addEventListener('error', function () {
      if (done) return;
      done = true;
      if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
      a.classList.remove('is-video', 'no-thumb');
      a.classList.add('no-thumb');
      if (!a.querySelector('.link-fav') && !a.querySelector('.ref-fav')) {
        a.insertBefore(faviconEl(url, kind === 'ref' ? 'ref-fav' : 'link-fav'), a.firstChild);
      }
    });
  }

  function youtubeLinkCard(link, id) {
    var a = document.createElement('a');
    a.className = 'link-card is-video';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('data-yt-id', id);

    var thumb = youtubeThumbEl(id);
    a.appendChild(thumb);

    var body = el('div', 'link-body');
    var title = el('div', 'link-title yt-title');
    body.appendChild(title);
    body.appendChild(el('div', 'link-domain', 'youtube.com'));
    body.appendChild(el('div', 'link-url', link.url));
    a.appendChild(body);

    var meta = youtubeMetaOf(id);
    if (meta) {
      title.textContent = meta.title;
      a.classList.add('has-title');
    }
    requestYouTubeTitle(id);
    fallbackToFavicon(a, thumb, link.url, 'link');
    return a;
  }

  function linkCard(link) {
    var ytId = U.youtubeId ? U.youtubeId(link.url) : '';
    if (ytId) return youtubeLinkCard(link, ytId);

    var a = document.createElement('a');
    a.className = 'link-card';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    var body = el('div', 'link-body');
    body.appendChild(el('div', 'link-domain', hostOf(link.url)));
    body.appendChild(el('div', 'link-url', link.url));

    a.appendChild(faviconEl(link.url, 'link-fav'));
    a.appendChild(body);
    return a;
  }

  /* ---------------------------------------------------------- */
  /* 말풍선 분류 배지 (사진·링크 카테고리를 한눈에)                 */
  /* ---------------------------------------------------------- */

  function memoBadgeCategories(m) {
    var out = [];
    var seen = {};
    var add = function (cat, kind) {
      if (!cat) return;
      if (seen[cat]) { seen[cat].kinds[kind] = 1; return; }
      var item = { cat: cat, kinds: {} };
      item.kinds[kind] = 1;
      seen[cat] = item;
      out.push(item);
    };
    (m.images || []).forEach(function (img) { add(photoCategoryOf(img), 'img'); });
    (m.links || []).forEach(function (l) { add(linkCategoryOf(l), 'link'); });
    var memoCat = memoCategoryOfMemo(m);
    if (memoCat) add(memoCat, 'memo');
    return out;
  }

  function catBadgeRow(m) {
    var cats = memoBadgeCategories(m);
    if (!cats.length) return null;
    var row = el('div', 'cat-badges');
    cats.forEach(function (item) {
      var b = el('button', 'cat-badge', catBadgeText(item.cat));
      b.type = 'button';
      b.setAttribute('data-cat', item.cat);
      b.title = '분류 바꾸기';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openMemoCategorySheet(m, item.kinds, item.cat);
      });
      row.appendChild(b);
    });
    return row;
  }

  /* 🕒 타임라인 피드 — 이 항목이 사진·링크·메모 중 무엇인지 한눈에 */
  function feedTypeBadge(m) {
    var parts = [];
    var nImg = (m.images || []).length;
    var nLink = (m.links || []).length;
    if (nImg) parts.push('🖼️ 사진' + (nImg > 1 ? ' ' + nImg : ''));
    if (nLink) parts.push('🔗 링크');
    if (!nImg && !nLink) parts.push('📝 메모');
    return el('div', 'feed-type', parts.join(' · '));
  }

  function messageEl(m, feed) {
    var row = el('div', 'msg' + (m.pinned ? ' pinned' : '') + (feed ? ' in-feed' : ''));
    row.setAttribute('data-id', m.id);

    var time = el('span', 'msg-time');
    if (m.pinned) time.appendChild(el('span', 'pin-mark', '📌'));
    time.appendChild(document.createTextNode(U.timeLabel(m.created_at)));

    var bubble = el('div', 'bubble');
    var hasImages = (m.images || []).length > 0;
    if (hasImages) bubble.classList.add('has-img');

    if (state.editingId === m.id) {
      row.classList.add('editing');
      var ta = document.createElement('textarea');
      ta.className = 'edit-area';
      ta.value = m.content;
      ta.rows = Math.min(8, Math.max(2, m.content.split('\n').length));
      var bar = el('div', 'edit-bar');
      var save = el('button', 'mini primary', '저장');
      var cancel = el('button', 'mini', '취소');
      save.type = 'button';
      cancel.type = 'button';
      save.addEventListener('click', function () { saveEdit(m, ta.value); });
      cancel.addEventListener('click', function () { state.editingId = null; render(); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(m, ta.value); }
        if (e.key === 'Escape') { state.editingId = null; render(); }
      });
      bar.appendChild(save);
      bar.appendChild(cancel);
      bubble.appendChild(ta);
      bubble.appendChild(bar);
      setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
    } else {
      if (feed) bubble.appendChild(feedTypeBadge(m));
      var catRow = catBadgeRow(m);
      if (catRow) bubble.appendChild(catRow);
      if (hasImages) bubble.appendChild(imageGrid(m));

      // 본문이 주소뿐이면 링크 카드만 보여 준다 (프로토콜 유무 차이는 무시하고 비교)
      var noScheme = function (s) { return String(s || '').replace(/https?:\/\//gi, ''); };
      var onlyUrls = (m.links || []).length > 0 &&
        noScheme(m.content).replace(/\s+/g, ' ').trim() ===
        (m.links || []).map(function (l) { return noScheme(l.url); }).join(' ');

      if (m.content && !onlyUrls) {
        var text = el('div', 'msg-text');
        appendRichText(text, m.content);
        bubble.appendChild(text);
      }
      (m.links || []).forEach(function (l) { bubble.appendChild(linkCard(l)); });

      if (!m.content && !hasImages && !(m.links || []).length) {
        bubble.appendChild(el('div', 'msg-text muted', '(빈 메모)'));
      }
    }

    var more = el('button', 'msg-more', '⋮');
    more.type = 'button';
    more.setAttribute('aria-label', '메모 메뉴');
    more.addEventListener('click', function (e) { e.stopPropagation(); openMemoSheet(m); });

    var pressTimer = null;
    var longPressed = false;
    bubble.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      longPressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () {
        longPressed = true;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        openMemoSheet(m);
      }, 500);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(function (ev) {
      bubble.addEventListener(ev, function () { clearTimeout(pressTimer); });
    });
    bubble.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openMemoSheet(m);
    });
    bubble.addEventListener('click', function () {
      if (longPressed) { longPressed = false; }
    });

    row.appendChild(time);
    row.appendChild(bubble);
    row.appendChild(more);
    return row;
  }

  /* 사진 갤러리·링크 카드에서도 같은 메모 메뉴를 연다 (길게 누르기 / 우클릭) */
  function attachLongPress(node, m) {
    var timer = null;
    var fired = false;
    node.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      fired = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fired = true;
        if (m && navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        openMemoSheet(m);
      }, 500);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(function (ev) {
      node.addEventListener(ev, function () { clearTimeout(timer); });
    });
    node.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openMemoSheet(m);
    });
    node.addEventListener('click', function (e) {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
  }

  function dateDivider(iso) {
    var d = el('div', 'date-divider');
    d.appendChild(el('span', '', U.dateLabel(iso)));
    return d;
  }

  function emptyState(kind) {
    var box = el('div', 'empty');
    var emoji = kind === 'photos' ? '🖼️' : kind === 'links' ? '🔗' : kind === 'memo' ? '📝' : '💬';
    box.appendChild(el('div', 'empty-emoji', emoji));
    if (kind === 'photos') {
      box.appendChild(el('p', 'empty-title', '아직 사진이 없어요'));
      box.appendChild(el('p', 'empty-sub', '아래 ＋ 버튼으로 사진을 첨부해 보세요. 위 + 로 분류를 먼저 만들 수도 있어요.'));
    } else if (kind === 'links') {
      box.appendChild(el('p', 'empty-title', '아직 링크가 없어요'));
      box.appendChild(el('p', 'empty-sub', '메모에 주소를 붙여넣으면 링크 카드로 정리돼요.'));
    } else if (state.query || state.tag) {
      box.appendChild(el('p', 'empty-title', '조건에 맞는 메모가 없어요'));
      box.appendChild(el('p', 'empty-sub', '검색어나 태그 필터를 바꿔 보세요.'));
    } else if (kind === 'memo') {
      box.appendChild(el('p', 'empty-title', '아직 글자 메모가 없어요'));
      box.appendChild(el('p', 'empty-sub', '입력창 위 📝 메모 분류를 고르고 보내면 여기에 쌓여요. 사진·링크 메모는 각 탭에만 보여요.'));
    } else {
      box.appendChild(el('p', 'empty-title', '아직 저장한 레퍼런스가 없어요'));
      box.appendChild(el('p', 'empty-sub', '사진·링크·메모를 남기면 카톡 ‘나와의 채팅’처럼 쌓여요.'));
      box.appendChild(el('div', 'empty-hints', '#화장품  #데드쿨  #단상자 처럼 태그를 붙여보세요'));
    }
    return box;
  }

  function renderTimeline(list) {
    els.pinnedSection.innerHTML = '';
    els.timeline.innerHTML = '';
    els.altView.innerHTML = '';
    els.altView.classList.add('hidden');

    var pinned = list.filter(function (m) { return m.pinned; });
    var rest = list.filter(function (m) { return !m.pinned; });

    if (pinned.length) {
      var head = el('div', 'pinned-head');
      head.appendChild(el('span', 'pinned-title', '📌 고정된 메모'));
      head.appendChild(el('span', 'pinned-count', String(pinned.length)));
      els.pinnedSection.appendChild(head);
      var wrap = el('div', 'pinned-list');
      pinned.forEach(function (m) { wrap.appendChild(messageEl(m)); });
      els.pinnedSection.appendChild(wrap);
      els.pinnedSection.classList.remove('hidden');
    } else {
      els.pinnedSection.classList.add('hidden');
    }

    if (!rest.length && !pinned.length) {
      els.timeline.appendChild(emptyState('memo'));
    } else {
      var lastKey = null;
      rest.forEach(function (m) {
        var k = U.dateKey(m.created_at);
        if (k !== lastKey) {
          els.timeline.appendChild(dateDivider(m.created_at));
          lastKey = k;
        }
        els.timeline.appendChild(messageEl(m));
      });
    }

    els.scroller.classList.remove('alt-mode');
    hydrateImages();
  }

  /* 🕒 타임라인 탭 = 사진·링크·글자 메모 구분 없이 전부를 최신순(맨 위가 가장 최근)으로 모아 본다 */
  function feedTime(m) {
    var t = new Date(m.updated_at || m.created_at).getTime();
    return isNaN(t) ? 0 : t;
  }

  function renderFeed(list) {
    els.pinnedSection.innerHTML = '';
    els.pinnedSection.classList.add('hidden');
    els.altView.innerHTML = '';
    els.altView.classList.add('hidden');
    els.timeline.classList.remove('hidden');
    els.timeline.innerHTML = '';
    els.scroller.classList.remove('alt-mode');

    var sorted = list.slice().sort(function (a, b) {
      var d = feedTime(b) - feedTime(a);
      if (d) return d;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    if (!sorted.length) {
      els.timeline.appendChild(emptyState('timeline'));
      return;
    }

    var head = el('div', 'feed-head');
    head.appendChild(el('span', '', '🕒 최신순 · ' + sorted.length + '건'));
    els.timeline.appendChild(head);

    var lastKey = null;
    sorted.forEach(function (m) {
      var k = U.dateKey(m.created_at);
      if (k !== lastKey) {
        els.timeline.appendChild(dateDivider(m.created_at));
        lastKey = k;
      }
      els.timeline.appendChild(messageEl(m, true));
    });

    hydrateImages();
  }

  /* 사진 탭 상단 분류 칩 줄 — 사진이 0장이어도 분류를 확인·추가할 수 있게 항상 그린다 */
  function photoCatRow(cells) {
    var counts = photoCategoryCounts(cells);
    var row = el('div', 'link-cat-row photo-cat-row');
    var chipFor = function (label, cat, count) {
      var active = cat === null ? !state.photoCat : state.photoCat === cat;
      var b = el('button', 'chip' + (active ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('data-cat', cat === null ? '' : cat);
      b.appendChild(document.createTextNode(label));
      b.appendChild(el('span', 'chip-count', String(count)));
      b.addEventListener('click', function () {
        state.photoCat = (cat === null || active) ? null : cat;
        render();
      });
      attachCatChipOps(b, 'photo', cat, count);
      return b;
    };
    row.appendChild(chipFor('전체', null, cells.length));
    photoCategories().forEach(function (cat) {
      row.appendChild(chipFor(cat, cat, counts.get(cat) || 0));
    });
    var addChip = el('button', 'chip add', '+');
    addChip.type = 'button';
    addChip.setAttribute('aria-label', '사진 분류 추가');
    addChip.title = '분류 추가';
    addChip.addEventListener('click', function () { addPhotoCategory(); });
    row.appendChild(addChip);
    return row;
  }

  function renderPhotos(list) {
    els.pinnedSection.innerHTML = '';
    els.pinnedSection.classList.add('hidden');
    els.timeline.innerHTML = '';
    els.timeline.classList.add('hidden');
    els.altView.classList.remove('hidden');
    els.altView.innerHTML = '';
    els.scroller.classList.add('alt-mode');

    var cells = [];
    list.slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
      .forEach(function (m) {
        (m.images || []).forEach(function (img, idx) {
          cells.push({ memo: m, img: img, index: idx });
        });
      });

    /* 분류 칩 — 사진이 0장이어도 상단에 보여 주고, 아래에 빈 상태 안내 */
    els.altView.appendChild(photoCatRow(cells));

    if (!cells.length) {
      els.altView.appendChild(emptyState('photos'));
      return;
    }

    var shown = state.photoCat
      ? cells.filter(function (c) { return photoCategoryOf(c.img) === state.photoCat; })
      : cells;

    if (!shown.length) {
      var box = el('div', 'empty');
      box.appendChild(el('div', 'empty-emoji', '🖼️'));
      box.appendChild(el('p', 'empty-title', '이 분류에 사진이 없어요'));
      box.appendChild(el('p', 'empty-sub', '다른 분류를 눌러 보세요.'));
      els.altView.appendChild(box);
      return;
    }

    var grid = el('div', 'gallery');
    shown.forEach(function (c) {
      var btn = el('button', 'g-cell');
      btn.type = 'button';
      var image = document.createElement('img');
      image.alt = '사진';
      image.loading = 'lazy';
      image.className = 'loading';
      image.setAttribute('data-key', c.img.key || '');
      if (c.img.url) image.setAttribute('data-url', c.img.url);
      if (c.img.path) image.setAttribute('data-path', c.img.path);
      btn.appendChild(image);
      if (state.query || state.tag) {
        btn.appendChild(el('span', 'g-meta', shortDate(c.memo.created_at)));
      }
      var catBtn = el('span', 'g-cat', catBadgeText(photoCategoryOf(c.img)));
      catBtn.setAttribute('role', 'button');
      catBtn.setAttribute('tabindex', '0');
      catBtn.setAttribute('data-cat', photoCategoryOf(c.img));
      catBtn.setAttribute('aria-label', '사진 분류 바꾸기');
      catBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPhotoCategorySheet(c.memo, c.img.key);
      });
      btn.appendChild(catBtn);
      btn.addEventListener('click', function () { openLightbox(c.memo, c.index); });
      attachLongPress(btn, c.memo);
      grid.appendChild(btn);
    });
    els.altView.appendChild(grid);
    hydrateImages();
  }

  /* 링크 탭 상단 분류 칩 줄 — 링크가 0건이어도 분류를 확인·추가할 수 있게 항상 보여 준다 */
  function linkCatRow(items) {
    var counts = categoryCounts(items);
    var row = el('div', 'link-cat-row');
    var chipFor = function (label, cat, count) {
      var active = cat === null ? !state.linkCat : state.linkCat === cat;
      var b = el('button', 'chip' + (active ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('data-cat', cat === null ? '' : cat);
      b.appendChild(document.createTextNode(label));
      b.appendChild(el('span', 'chip-count', String(count)));
      b.addEventListener('click', function () {
        state.linkCat = (cat === null || active) ? null : cat;
        render();
      });
      attachCatChipOps(b, 'link', cat, count);
      return b;
    };
    row.appendChild(chipFor('전체', null, items.length));
    linkCategories().forEach(function (cat) {
      row.appendChild(chipFor(cat, cat, counts.get(cat) || 0));
    });
    var addChip = el('button', 'chip add', '+');
    addChip.type = 'button';
    addChip.setAttribute('aria-label', '링크 분류 추가');
    addChip.title = '분류 추가';
    addChip.addEventListener('click', function () { addLinkCategory(); });
    row.appendChild(addChip);
    return row;
  }

  function renderLinks(list) {
    els.pinnedSection.innerHTML = '';
    els.pinnedSection.classList.add('hidden');
    els.timeline.innerHTML = '';
    els.timeline.classList.add('hidden');
    els.altView.classList.remove('hidden');
    els.altView.innerHTML = '';
    els.scroller.classList.add('alt-mode');

    var items = [];
    list.forEach(function (m) {
      (m.links || []).forEach(function (l) { items.push({ memo: m, link: l }); });
    });
    items.sort(function (a, b) { return new Date(b.memo.created_at) - new Date(a.memo.created_at); });

    /* 분류 칩 — 링크가 0건이어도 상단에 보여 준다 */
    els.altView.appendChild(linkCatRow(items));

    var shown = state.linkCat
      ? items.filter(function (it) { return linkCategoryOf(it.link) === state.linkCat; })
      : items;

    if (!shown.length) {
      var box = el('div', 'empty');
      box.appendChild(el('div', 'empty-emoji', '🔗'));
      box.appendChild(el('p', 'empty-title', items.length ? '이 분류에 링크가 없어요' : '아직 링크가 없어요'));
      box.appendChild(el('p', 'empty-sub', items.length ? '다른 분류를 눌러 보세요.' : '메모에 주소를 붙여넣으면 링크 카드로 정리돼요.'));
      els.altView.appendChild(box);
      return;
    }

    var wrap = el('div', 'ref-list');
    shown.forEach(function (it) {
      var cell = el('div', 'ref-item');
      var ytId = U.youtubeId ? U.youtubeId(it.link.url) : '';

      var a = document.createElement('a');
      a.className = 'ref-card' + (ytId ? ' is-video' : '');
      a.href = it.link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      var thumb = null;
      if (ytId) {
        cell.classList.add('is-video');
        a.setAttribute('data-yt-id', ytId);
        thumb = youtubeThumbEl(ytId);
        a.appendChild(thumb);
      }

      var body = el('div', 'ref-body');
      var title = null;
      if (ytId) {
        title = el('div', 'ref-title yt-title');
        body.appendChild(title);
        var ytMetaCached = youtubeMetaOf(ytId);
        if (ytMetaCached) {
          title.textContent = ytMetaCached.title;
          a.classList.add('has-title');
        }
      }
      body.appendChild(el('div', 'ref-domain', ytId ? 'youtube.com' : hostOf(it.link.url)));
      body.appendChild(el('div', 'ref-url', it.link.url));
      var note = U.stripUrls(it.memo.content).replace(/\s+/g, ' ').trim();
      if (note) body.appendChild(el('div', 'ref-note', note));

      var cat = linkCategoryOf(it.link);
      var badge = el('button', 'ref-cat', catBadgeText(cat));
      badge.type = 'button';
      badge.setAttribute('data-cat', cat);
      badge.setAttribute('aria-label', '링크 분류 바꾸기');
      badge.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openCategorySheet(it.memo, it.link);
      });

      var foot = el('div', 'ref-foot');
      foot.appendChild(el('span', '', shortDate(it.memo.created_at) + ' ' + U.timeLabel(it.memo.created_at)));
      var right = el('span', 'ref-foot-right');
      var refTags = visibleTagsOf(it.memo);
      if (refTags.length) {
        right.appendChild(el('span', 'ref-tags', refTags.map(function (t) { return '#' + t; }).join(' ')));
      }
      if (ytId) {
        // 유튜브 카드는 썸네일 폭을 비우지 않도록 분류 배지를 카드 아래 줄에 둔다
        badge.classList.add('inline');
        right.appendChild(badge);
      }
      if (right.childNodes.length) foot.appendChild(right);
      body.appendChild(foot);

      if (ytId) {
        requestYouTubeTitle(ytId);
        if (thumb) fallbackToFavicon(a, thumb, it.link.url, 'ref');
      } else {
        a.appendChild(faviconEl(it.link.url, 'ref-fav'));
      }
      a.appendChild(body);
      attachLongPress(a, it.memo);
      cell.appendChild(a);

      if (!ytId) cell.appendChild(badge);

      wrap.appendChild(cell);
    });
    els.altView.appendChild(wrap);
  }

  function render() {
    var list = filteredMemos();
    var memoOnly = list.filter(isMemoTabMemo);
    renderTagbar(memoOnly);
    els.timeline.classList.remove('hidden');

    if (state.view === 'photos') {
      renderPhotos(list.filter(function (m) { return (m.images || []).length > 0; }));
    } else if (state.view === 'links') {
      // 🔗 링크 탭 = 사진 없이 링크만 있는 메모 (📝 메모 탭 메모는 제외)
      renderLinks(list.filter(function (m) {
        return !(m.images || []).length && !memoCategoryOfMemo(m);
      }));
    } else if (state.view === 'timeline') {
      // 🕒 타임라인 탭 = 사진·링크·글자 메모 전부 최신순
      renderFeed(list);
    } else {
      renderTimeline(state.memoCat
        ? memoOnly.filter(function (m) { return memoCategoryName(m) === state.memoCat; })
        : memoOnly);
    }

    var total = state.memos.filter(function (m) { return !m.deleted; }).length;
    els.countBadge.textContent = total ? String(total) : '';
    els.jumpLatest.classList.toggle('hidden', isNearBottom() || state.view !== 'memo');
  }

  /* ---------------------------------------------------------- */
  /* 라이트박스                                                 */
  /* ---------------------------------------------------------- */

  function openLightbox(memo, index) {
    state.lightbox = { memo: memo, i: index || 0 };
    els.lightbox.classList.add('open');
    document.body.classList.add('no-scroll');
    showLbImage();
  }

  function closeLightbox() {
    state.lightbox = null;
    els.lightbox.classList.remove('open');
    els.lbImg.removeAttribute('src');
    els.lbImg.classList.remove('zoomed');
    document.body.classList.remove('no-scroll');
  }

  function lbStep(delta) {
    var lb = state.lightbox;
    if (!lb) return;
    var images = lb.memo.images || [];
    var next = lb.i + delta;
    if (next < 0 || next >= images.length) return;
    lb.i = next;
    showLbImage();
  }

  function updateLbCat() {
    if (!els.lbCat) return;
    var lb = state.lightbox;
    if (!lb) return;
    var img = (lb.memo.images || [])[lb.i];
    els.lbCat.textContent = img ? catBadgeText(photoCategoryOf(img)) : '📌 기타 정보';
    els.lbCat.setAttribute('data-cat', img ? photoCategoryOf(img) : '');
  }

  function showLbImage() {
    var lb = state.lightbox;
    if (!lb) return;
    var images = lb.memo.images || [];
    var img = images[lb.i];
    updateLbCat();
    els.lbCounter.textContent = (lb.i + 1) + ' / ' + images.length;
    els.lbPrev.disabled = lb.i <= 0;
    els.lbNext.disabled = lb.i >= images.length - 1;
    els.lbPrev.classList.toggle('hidden', images.length < 2);
    els.lbNext.classList.toggle('hidden', images.length < 2);
    els.lbImg.classList.remove('zoomed');
    els.lbImg.removeAttribute('src');
    els.lbStage.classList.add('loading-img');

    resolveImage(img).then(function (url) {
      if (!state.lightbox || state.lightbox !== lb) return;
      els.lbStage.classList.remove('loading-img');
      if (url) {
        els.lbImg.src = url;
        els.lbDownload.href = url;
        els.lbDownload.setAttribute('download', (img && img.name) || ('memo-' + (lb.i + 1) + '.jpg'));
        els.lbDownload.classList.remove('disabled');
      } else {
        els.lbDownload.classList.add('disabled');
        els.lbDownload.removeAttribute('href');
      }
    });
  }

  /* ---------------------------------------------------------- */
  /* 메모 액션 시트                                             */
  /* ---------------------------------------------------------- */

  function openMemoSheet(m) {
    state.sheetMemo = m;
    els.sheetActions.innerHTML = '';
    els.sheetTitle.textContent = shortDate(m.created_at) + ' ' + U.timeLabel(m.created_at);

    var items = [
      { icon: '📋', label: '복사', run: function () { copyMemo(m); } },
      { icon: '✏️', label: '수정', run: function () { closeSheet(); state.editingId = m.id; render(); } },
      {
        icon: '📌',
        label: m.pinned ? '핀 고정 해제' : '핀 고정 (상단 고정)',
        run: function () {
          var wasPinned = m.pinned;
          Store.togglePin(m.id).then(function () {
            closeSheet();
            toast(wasPinned ? '핀 고정을 해제했어요' : '상단에 고정했어요');
          });
        }
      },
      { icon: '🗑️', label: '삭제', danger: true, run: function () { removeMemo(m); } }
    ];

    if ((m.images || []).length) {
      items.splice(items.length - 1, 0, {
        icon: '🖼️',
        label: '사진 분류',
        run: function () { openMemoPhotosSheet(m); }
      });
    }

    if ((m.links || []).length) {
      items.splice(items.length - 1, 0, {
        icon: '📁',
        label: '링크 분류',
        run: function () { openMemoLinksSheet(m); }
      });
    }

    if (isMemoTabMemo(m)) {
      items.splice(items.length - 1, 0, {
        icon: '📝',
        label: '메모 분류',
        run: function () { openMemoCatSheet(m); }
      });
    }

    // 🔗 링크로 보이던 메모를 📝 메모 탭 분류로 옮긴다 (링크 카드를 걱어내고 글자만)
    if ((m.links || []).length && !(m.images || []).length) {
      items.splice(items.length - 1, 0, {
        icon: '📝',
        label: '📝 메모 탭으로 옮기기',
        run: function () { closeSheet(); openMoveToMemoSheet([m.id]); }
      });
    }

    items.forEach(function (it) {
      var b = el('button', 'sheet-item' + (it.danger ? ' danger' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'si-icon', it.icon));
      b.appendChild(el('span', 'si-label', it.label));
      b.addEventListener('click', it.run);
      els.sheetActions.appendChild(b);
    });

    els.sheet.classList.add('open');
  }

  function closeSheet() {
    els.sheet.classList.remove('open');
    state.sheetMemo = null;
  }

  /* 분류 선택 시트 — 링크·사진·둘 다에 공통으로 쓴다 */
  function catSheet(opts) {
    var m = opts.memo;
    state.sheetMemo = m;
    els.sheetActions.innerHTML = '';
    els.sheetTitle.textContent = opts.title;

    (opts.categories() || []).forEach(function (cat) {
      var current = cat === opts.current;
      var b = el('button', 'sheet-item' + (current ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('data-cat', cat);
      b.appendChild(el('span', 'si-icon', current ? '✅' : catIcon(cat)));
      b.appendChild(el('span', 'si-label', cat));
      b.addEventListener('click', function () {
        Promise.resolve(opts.apply(cat)).then(function () {
          closeSheet();
          updateLbCat();
          if (opts.done) opts.done(cat);
          else toast("'" + cat + "'로 분류했어요");
        });
      });
      els.sheetActions.appendChild(b);
    });

    // 분류 선택지 밖의 보조 작업 (링크 분류 → 메모 탭으로 옮기기 등)
    var extras = opts.extra ? (opts.extra() || []) : [];
    extras.forEach(function (it) {
      var b = el('button', 'sheet-item');
      b.type = 'button';
      b.appendChild(el('span', 'si-icon', it.icon || '→'));
      b.appendChild(el('span', 'si-label', it.label));
      b.addEventListener('click', it.run);
      els.sheetActions.appendChild(b);
    });

    var add = el('button', 'sheet-item');
    add.type = 'button';
    add.appendChild(el('span', 'si-icon', '➕'));
    add.appendChild(el('span', 'si-label', '새 분류 추가'));
    add.addEventListener('click', function () {
      var name = opts.addCategory();
      if (name) catSheet(opts);
    });
    els.sheetActions.appendChild(add);

    els.sheet.classList.add('open');
  }

  /* 링크 한 개 또는 메모의 모든 링크에 분류를 지정한다 (+ 이 분류를 통째로 📝 메모 탭으로 옮기기) */
  function openCategorySheet(m, link) {
    var cat = link ? linkCategoryOf(link) : null;
    catSheet({
      memo: m,
      title: link ? '🔗 ' + hostOf(link.url) + ' 분류' : '🔗 링크 분류',
      categories: linkCategories,
      current: cat,
      addCategory: addLinkCategory,
      apply: function (next) {
        return Store.setLinkCategory(m.id, link ? link.url : null, next);
      },
      extra: function () {
        var ids = cat ? linkMemoIdsForCategory(cat) : [];
        if (ids.length < 2) return [];
        return [{
          icon: '📝',
          label: '이 분류 ' + ids.length + '개를 📝 메모 탭으로 옮기기',
          run: function () { openMoveToMemoSheet(ids); }
        }];
      }
    });
  }

  /* 한 링크 분류에만 속한(= 사진 없는) 링크 메모 id — 통째로 메모 탭으로 옮길 때 쓴다 */
  function linkMemoIdsForCategory(cat) {
    return state.memos.filter(function (m) {
      if (m.deleted) return false;
      if ((m.images || []).length) return false;
      var links = m.links || [];
      if (!links.length) return false;
      if (memoCategoryOfMemo(m)) return false;
      return links.every(function (l) { return linkCategoryOf(l) === cat; });
    }).map(function (m) { return m.id; });
  }

  /* 📝 메모 탭 분류 선택 시트 */
  function openMemoCatSheet(m) {
    catSheet({
      memo: m,
      title: '📝 메모 분류',
      categories: memoCategoryList,
      current: memoCategoryName(m),
      addCategory: addMemoCategory,
      apply: function (cat) { return Store.setMemoCategory(m.id, cat); }
    });
  }

  /* 🔗 링크 메모(들)을 📝 메모 탭 분류로 옮긴다 — 적용하면 링크 카드는 사라지고 글자만 남는다 */
  function openMoveToMemoSheet(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) return;
    catSheet({
      memo: null,
      title: '📝 메모 탭으로 옮기기 · ' + ids.length + '개',
      categories: memoCategoryList,
      current: null,
      addCategory: addMemoCategory,
      apply: function (cat) { return Store.moveToMemoTab(ids, cat); },
      done: function (cat) { toast('📝 ' + cat + ' · ' + ids.length + '개를 옮겼어요'); }
    });
  }

  /* 사진 한 장(key) 또는 메모의 모든 사진(key=null)에 분류를 지정한다 */
  function openPhotoCategorySheet(m, key) {
    var images = m.images || [];
    var idx = -1;
    images.forEach(function (img, i) { if (key && img.key === key) idx = i; });
    var label = idx >= 0
      ? '사진 ' + (idx + 1) + ' 분류'
      : '사진 전체 ' + images.length + '장 분류';
    catSheet({
      memo: m,
      title: '🖼️ ' + label,
      categories: photoCategories,
      current: idx >= 0 ? photoCategoryOf(images[idx]) : null,
      addCategory: addPhotoCategory,
      apply: function (cat) {
        return Store.setImageCategory(m.id, idx >= 0 ? key : null, cat);
      }
    });
  }

  /* 타임라인 ⋮ → 🖼️ 사진 분류 : 사진이 여러 장이면 어느 사진인지 먼저 고른다 */
  function openMemoPhotosSheet(m) {
    var images = m.images || [];
    if (!images.length) return;
    if (images.length === 1) { openPhotoCategorySheet(m, images[0].key); return; }

    state.sheetMemo = m;
    els.sheetActions.innerHTML = '';
    els.sheetTitle.textContent = '🖼️ 사진 분류 — 사진 선택';

    var all = el('button', 'sheet-item');
    all.type = 'button';
    all.appendChild(el('span', 'si-icon', '🗂️'));
    all.appendChild(el('span', 'si-label', '모든 사진 (' + images.length + '장)'));
    all.addEventListener('click', function () { openPhotoCategorySheet(m, null); });
    els.sheetActions.appendChild(all);

    images.forEach(function (img, i) {
      var b = el('button', 'sheet-item');
      b.type = 'button';
      b.appendChild(el('span', 'si-icon', '🖼️'));
      b.appendChild(el('span', 'si-label', '사진 ' + (i + 1) + ' · ' + catBadgeText(photoCategoryOf(img))));
      b.addEventListener('click', function () { openPhotoCategorySheet(m, img.key); });
      els.sheetActions.appendChild(b);
    });
    els.sheet.classList.add('open');
  }

  /* 말풍선 배지 → 그 배지의 분류를 가진 링크·사진만 바꿈 */
  function openMemoCategorySheet(m, kinds, cat) {
    if (kinds && kinds.memo) { openMemoCatSheet(m); return; }
    var imgs = (m.images || []).filter(function (img) { return photoCategoryOf(img) === cat; });
    var links = (m.links || []).filter(function (l) { return linkCategoryOf(l) === cat; });
    var targets = imgs.length + links.length;
    if (!targets) return;

    if (targets === 1) {
      if (imgs.length) openPhotoCategorySheet(m, imgs[0].key);
      else openCategorySheet(m, links[0]);
      return;
    }

    var keys = imgs.map(function (img) { return img.key; });
    var urls = links.map(function (l) { return l.url; });
    var parts = [];
    if (imgs.length) parts.push('사진 ' + imgs.length + '장');
    if (links.length) parts.push('링크 ' + links.length + '개');
    var photoOnly = imgs.length && !links.length;

    catSheet({
      memo: m,
      title: (catBadgeText(cat) + ' · ' + parts.join(' · ')).slice(0, 40),
      categories: photoOnly ? photoCategories : linkCategories,
      current: cat,
      addCategory: photoOnly ? addPhotoCategory : addLinkCategory,
      apply: function (next) {
        return Store.setCategories(m.id, {
          links: links.length ? urls : null,
          images: imgs.length ? keys : null
        }, next);
      }
    });
  }

  /* 타임라인 ⋮ → 📁 링크 분류 : 링크가 여러 개면 어느 링크인지 먼저 고른다 */
  function openMemoLinksSheet(m) {
    var links = m.links || [];
    if (!links.length) return;
    if (links.length === 1) { openCategorySheet(m, links[0]); return; }

    state.sheetMemo = m;
    els.sheetActions.innerHTML = '';
    els.sheetTitle.textContent = '📁 링크 분류 — 링크 선택';
    links.forEach(function (l) {
      var b = el('button', 'sheet-item');
      b.type = 'button';
      b.appendChild(el('span', 'si-icon', '🔗'));
      b.appendChild(el('span', 'si-label', hostOf(l.url) + ' · ' + linkCategoryOf(l)));
      b.addEventListener('click', function () { openCategorySheet(m, l); });
      els.sheetActions.appendChild(b);
    });
    els.sheet.classList.add('open');
  }

  function copyMemo(m) {
    var parts = [];
    if (m.content) parts.push(m.content);
    var contentLc = String(m.content || '').toLowerCase();
    (m.links || []).forEach(function (l) {
      var url = String(l.url || '');
      if (!url || parts.indexOf(url) !== -1) return;
      // 본문에 이미 적힌 주소(프로토콜 없이 적은 경우 포함)는 다시 붙이지 않는다
      if (contentLc.indexOf(url.toLowerCase()) !== -1) return;
      if (contentLc.indexOf(url.replace(/^https?:\/\//i, '').toLowerCase()) !== -1) return;
      parts.push(url);
    });
    var text = parts.join('\n');
    if (!text) text = (m.images || []).length ? '(사진 ' + m.images.length + '장)' : '';
    copyText(text).then(function (ok) {
      closeSheet();
      toast(ok ? '복사했어요' : '복사하지 못했어요');
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function removeMemo(m) {
    closeSheet();
    var ok = window.confirm('이 메모를 삭제할까요?\n삭제하면 되돌릴 수 없어요.');
    if (!ok) return;
    Store.deleteMemo(m.id).then(function () { toast('삭제했어요'); });
  }

  function saveEdit(m, value) {
    state.editingId = null;
    Store.updateMemo(m.id, { content: value }).then(function () { toast('수정했어요'); });
  }

  /* ---------------------------------------------------------- */
  /* 메모 작성                                                  */
  /* ---------------------------------------------------------- */

  function autoGrow() {
    var t = els.input;
    if (!t || !els.btnSend) return;
    t.style.height = 'auto';
    t.style.height = Math.min(132, Math.max(24, t.scrollHeight)) + 'px';
    els.btnSend.disabled = state.sending || (!t.value.trim() && !state.pending.length);
  }

  function send() {
    if (state.sending) return;
    var text = els.input.value.trim();
    if (!text && !state.pending.length) return;

    state.sending = true;
    els.btnSend.disabled = true;
    els.btnSend.classList.add('sending');

    var inMemoTab = state.view === 'memo';
    var images = state.pending.map(function (p) {
      return { key: p.key, w: p.w, h: p.h, type: p.type, size: p.size, name: p.name, url: '' };
    });
    /* 📝 메모 탭에서 보낸 글은 주소가 섞여 있어도 글자 그대로(links: []) 저장한다.
     * 사진을 붙였으면 사진 메모로 갈 곳이 🖼️ 사진 탭이므로 메모 분류를 붙이지 않는다. */
    var memoCategory = (inMemoTab && !images.length)
      ? (state.composerMemoCat || defaultMemoCategory())
      : '';

    Store.addMemo({
      content: text,
      images: images,
      linkCategory: inMemoTab ? undefined : (state.composerCat || undefined),
      photoCategory: state.composerPhotoCat || undefined,
      memoCategory: memoCategory || undefined
    }).then(function () {
      els.input.value = '';
      state.composerCat = null;
      state.composerPhotoCat = null;
      updateLinkCatBar();
      updatePhotoCatBar();
      state.pending.forEach(function (p) { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
      state.pending = [];
      renderPending();
      autoGrow();
      hideTagSuggest();

      // 보낸 메모가 실제로 자리잡는 탭으로 따라간다 (🕒 타임라인에서 보냈으면 타임라인 유지)
      var landing = state.view === 'timeline' ? 'timeline'
        : images.length ? 'photos'
        : (inMemoTab ? 'memo' : ((U.parseLinks(text).length) ? 'links' : 'memo'));
      if (state.view !== landing) {
        state.tag = null;
        state.view = landing;
        syncViewTabs();
      }
      if (landing === 'memo' && state.memoCat && state.memoCat !== memoCategory) state.memoCat = null;
      updateMemoCatBar();
      updateLinkCatBar();
      render();
      if (landing === 'timeline') els.scroller.scrollTop = 0;
      else scrollToBottom(true);
      if (memoCategory && U.parseLinks(text).length) toast('📝 메모로 저장했어요');
    }).catch(function (e) {
      console.error(e);
      toast('저장하지 못했어요');
    }).then(function () {
      state.sending = false;
      els.btnSend.classList.remove('sending');
      autoGrow();
    });
  }

  /* ---------------------------------------------------------- */
  /* 태그 자동완성                                              */
  /* ---------------------------------------------------------- */

  function hideTagSuggest() {
    if (!els.tagSuggest) return;
    els.tagSuggest.classList.add('hidden');
    els.tagSuggest.innerHTML = '';
  }

  function updateTagSuggest() {
    if (!els.tagSuggest) return;
    var caret = els.input.selectionStart || 0;
    var before = els.input.value.slice(0, caret);
    var m = before.match(/(^|[\s(\[{])#([0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\-]*)$/);
    if (!m) { hideTagSuggest(); return; }

    var q = m[2].toLowerCase();
    var tags = tagCounts().filter(function (t) {
      return !q || String(t.name).toLowerCase().indexOf(q) === 0;
    }).slice(0, 12);

    if (!tags.length) { hideTagSuggest(); return; }

    els.tagSuggest.innerHTML = '';
    els.tagSuggest.appendChild(el('span', 'ts-label', '태그'));
    tags.forEach(function (t) {
      var b = el('button', 'chip small', '#' + t.name);
      b.type = 'button';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { insertTag(t.name); });
      els.tagSuggest.appendChild(b);
    });
    els.tagSuggest.classList.remove('hidden');
  }

  function insertTag(tag) {
    var caret = els.input.selectionStart || 0;
    var before = els.input.value.slice(0, caret);
    var m = before.match(/(^|[\s(\[{])#([0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\-]*)$/);
    if (!m) return;
    var start = caret - m[2].length - 1;
    var after = els.input.value.slice(caret);
    els.input.value = els.input.value.slice(0, start) + '#' + tag + ' ' + after;
    var pos = start + tag.length + 2;
    els.input.setSelectionRange(pos, pos);
    els.input.focus();
    hideTagSuggest();
    autoGrow();
  }

  /* ---------------------------------------------------------- */
  /* 설정 시트                                                  */
  /* ---------------------------------------------------------- */

  function openSettings() {
    state.settingsOpen = true;
    renderSettings();
    els.settings.classList.add('open');
  }

  function closeSettings() {
    state.settingsOpen = false;
    els.settings.classList.remove('open');
  }

  function renderSettings() {
    var st = Store.getStatus();
    var cloud = Store.isCloud();

    var stateText = {
      local: '로컬 모드 (이 기기에만 저장)',
      signedout: '로그인 필요',
      signing: '로그인 중…',
      syncing: '동기화 중…',
      synced: '동기화됨',
      offline: '오프라인 — 연결되면 자동 재시도',
      error: '동기화 오류'
    }[st.state] || st.state;

    els.setSyncInfo.innerHTML = '';
    els.setSyncInfo.appendChild(el('div', 'set-sync-state ' + st.state, stateText));
    if (st.lastSync) els.setSyncInfo.appendChild(el('div', 'set-sync-sub', '마지막 동기화 ' + U.timeLabel(st.lastSync)));
    if (st.error) els.setSyncInfo.appendChild(el('div', 'set-sync-err', st.error));

    els.setSyncNow.disabled = !cloud;
    els.setSyncNow.textContent = '지금 동기화';
    els.setSyncNow.classList.toggle('hidden', !cloud);

    $$('input[name="quality"]').forEach(function (r) {
      r.checked = r.value === state.settings.imageQuality;
    });
    els.shiftEnter.checked = !!state.settings.shiftEnterSend;
    els.autoLock.value = String(state.settings.autoLockMin);
    els.setImageNote.textContent = state.settings.imageQuality === 'optimized'
      ? '장변 1600px · JPEG 82% 로 줄여서 저장해요 (원본 파일은 기기에 보관)'
      : '원본 화질 그대로 저장해요 (용량이 커질 수 있어요)';

    var pin = getPin();
    els.setPinState.textContent = pin ? 'PIN 잠금 사용 중' : 'PIN 잠금 꺼짐';
    els.setPinBtn.textContent = pin ? 'PIN 변경 / 해제' : 'PIN 잠금 설정';
    els.btnLockNow.classList.toggle('hidden', !pin);

    if (state.installEvent) els.setInstall.classList.remove('hidden');
    else els.setInstall.classList.add('hidden');

    els.setVersion.textContent = 'v' + APP_VERSION + ' · 메모 ' + state.memos.filter(function (m) { return !m.deleted; }).length + '개';

    renderAccount();
  }

  function setupPin() {
    var pin = getPin();
    if (!pin) { askNewPin(); return; }

    var cur = window.prompt('현재 PIN 4~6자리를 입력하세요');
    if (cur === null) return;

    hashPin(cur.trim(), pin.salt).then(function (h) {
      if (h !== pin.hash) { alert('PIN이 맞지 않아요'); return; }
      askNewPin();
    });
  }

  function askNewPin() {
    var next = window.prompt('새 PIN 4~6자리 숫자를 입력하세요.\n(비우고 확인을 누르면 잠금이 해제됩니다)');
    if (next === null) return;
    next = next.trim();

    if (!next) {
      setPinData(null);
      state.unlocked = true;
      toast('PIN 잠금을 해제했어요');
      renderSettings();
      return;
    }
    if (!/^\d{4,6}$/.test(next)) { alert('숫자 4~6자리만 사용할 수 있어요'); return; }

    var salt = randomHex(16);
    hashPin(next, salt).then(function (hash) {
      setPinData({ salt: salt, hash: hash, setAt: new Date().toISOString() });
      state.unlocked = true;
      toast('PIN 잠금을 설정했어요');
      renderSettings();
    });
  }

  /* ---------------------------------------------------------- */
  /* PIN 잠금 화면                                              */
  /* ---------------------------------------------------------- */

  function renderPinDots() {
    els.lockDots.innerHTML = '';
    for (var i = 0; i < 6; i++) {
      els.lockDots.appendChild(el('span', 'dot' + (i < state.pinBuffer.length ? ' on' : '')));
    }
  }

  function showLock() {
    if (!getPin()) return;
    state.unlocked = false;
    state.pinBuffer = '';
    renderPinDots();
    els.lockMsg.textContent = 'PIN 4~6자리를 입력해 주세요';
    els.lock.classList.add('open');
    document.body.classList.add('locked');
  }

  function hideLock() {
    state.unlocked = true;
    state.pinBuffer = '';
    els.lock.classList.remove('open');
    document.body.classList.remove('locked');
    els.lockInput.value = '';
  }

  function lockDigit(d) {
    if (state.pinLockUntil > Date.now()) {
      els.lockMsg.textContent = '잠시 후 다시 시도해 주세요';
      return;
    }
    if (state.pinBuffer.length >= 6) return;
    state.pinBuffer += d;
    renderPinDots();
    els.lockMsg.textContent = ' ';
  }

  function lockBackspace() {
    state.pinBuffer = state.pinBuffer.slice(0, -1);
    renderPinDots();
  }

  function tryUnlock() {
    if (state.pinLockUntil > Date.now()) return;
    var pin = getPin();
    if (!pin) { hideLock(); return; }
    if (!/^\d{4,6}$/.test(state.pinBuffer)) {
      els.lockMsg.textContent = '숫자 4~6자리를 입력해 주세요';
      return;
    }
    hashPin(state.pinBuffer, pin.salt).then(function (h) {
      if (h === pin.hash) {
        state.pinFails = 0;
        hideLock();
        return;
      }
      state.pinFails++;
      state.pinBuffer = '';
      renderPinDots();
      els.lock.classList.remove('shake');
      void els.lock.offsetWidth;
      els.lock.classList.add('shake');
      if (state.pinFails >= 10) {
        state.pinLockUntil = Date.now() + 30000;
        els.lockMsg.textContent = '10회 실패 — 30초 후 다시 시도해 주세요';
      } else {
        els.lockMsg.textContent = 'PIN이 맞지 않아요 (' + state.pinFails + '회)';
      }
    });
  }

  /* ---------------------------------------------------------- */
  /* Supabase 로그인 게이트                                     */
  /* ---------------------------------------------------------- */

  function cloudConfigured() {
    var c = window.MEMO_CONFIG || {};
    var url = String(c.supabaseUrl || '').trim();
    var key = String(c.supabaseAnonKey || '').trim();
    return /^https?:\/\//.test(url) && key.length >= 20;
  }

  function showAuthError(msg) {
    if (!els.authError) return;
    els.authError.textContent = String(msg || '');
    els.authError.classList.toggle('hidden', !msg);
  }

  function hideAuthError() { showAuthError(''); }

  function setAuthBusy(on) {
    if (!els.authSubmit) return;
    els.authSubmit.disabled = !!on;
    els.authSubmit.textContent = on ? '로그인 중…' : '로그인';
  }

  function updateAuthGate(authState) {
    if (!els.authGate) return;
    var a = authState || (Store.getAuthState ? Store.getAuthState() : { required: false, signedIn: true });
    var need = !!a.required && !a.signedIn;

    els.authGate.classList.toggle('open', need);
    document.body.classList.toggle('auth-locked', need);
    els.authLocalBtn.classList.toggle('hidden', cloudConfigured());

    if (need) {
      if (a.error) showAuthError(a.error);
      setTimeout(function () {
        if (!els.authEmail.value) els.authEmail.focus();
        else els.authPass.focus();
      }, 80);
    }
  }

  function submitAuth(e) {
    if (e) e.preventDefault();
    var email = String(els.authEmail.value || '').trim();
    var pass = String(els.authPass.value || '');

    if (!email) { showAuthError('이메일을 입력해 주세요'); els.authEmail.focus(); return; }
    if (!pass) { showAuthError('비밀번호를 입력해 주세요'); els.authPass.focus(); return; }

    hideAuthError();
    setAuthBusy(true);

    Store.signIn(email, pass, !!els.authKeep.checked).then(function () {
      els.authPass.value = '';
      setAuthBusy(false);
      hideAuthError();
      updateAuthGate(Store.getAuthState());
      state.memos = Store.getMemos();
      render();
      scrollToBottom(false);
      toast('로그인했어요');
    }).catch(function (err) {
      setAuthBusy(false);
      showAuthError(String((err && err.message) || err));
    });
  }

  function renderAccount() {
    if (!els.setAccount) return;
    var a = Store.getAuthState ? Store.getAuthState() : { required: false, signedIn: false, email: '' };

    els.setAccount.innerHTML = '';
    if (a.required && a.signedIn) {
      els.setAccount.appendChild(el('div', 'set-account-email', a.email || '로그인됨'));
      els.setAccount.appendChild(el('div', 'set-account-sub', 'Supabase 계정으로 로그인됨'));
    } else if (a.required) {
      els.setAccount.appendChild(el('div', 'set-account-email', '로그인하지 않음'));
      els.setAccount.appendChild(el('div', 'set-account-sub', '다시 로그인하면 서버에서 메모를 내려받아요'));
    } else {
      els.setAccount.appendChild(el('div', 'set-account-email', '로컬 미리보기 모드'));
      els.setAccount.appendChild(el('div', 'set-account-sub', 'config.js 가 비어 있어 이 기기에만 저장됩니다'));
    }

    els.setSignOut.classList.toggle('hidden', !(a.required && a.signedIn));

    if (els.setAccountNote) {
      if (a.required && a.signedIn) {
        els.setAccountNote.textContent = '로그아웃하면 이 기기의 메모 캐시가 지워지고, 다시 로그인하면 서버에서 새로 내려받아요.';
        els.setAccountNote.classList.remove('hidden');
      } else if (a.required) {
        els.setAccountNote.textContent = '로그인하면 폰·PC 메모가 자동으로 동기화돼요.';
        els.setAccountNote.classList.remove('hidden');
      } else {
        els.setAccountNote.textContent = '';
        els.setAccountNote.classList.add('hidden');
      }
    }
  }

  /* ---------------------------------------------------------- */
  /* 이벤트 연결                                                */
  /* ---------------------------------------------------------- */

  function syncViewTabs() {
    $$('.vt', els.viewTabs).forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === state.view);
    });
  }

  function setView(view) {
    /* 사진·링크 탭에는 태그 필터 바가 없으므로, 📝 메모 탭에서 걸어 둔 태그 필터를 들고 가지 않는다
     * (들고 가면 사진·링크 탭이 조건에 걸린 일부만 보여 비어 보일 수 있다) */
    if (view !== 'memo' && state.tag !== null) {
      state.tag = null;
      if (els.tagbar) els.tagbar.innerHTML = '';
    }
    state.view = view;
    syncViewTabs();
    updateMemoCatBar();
    updateLinkCatBar();
    var near = isNearBottom();
    render();
    if (view === 'timeline') els.scroller.scrollTop = 0;   // 최신 항목이 맨 위
    else if (near && view === 'memo') scrollToBottom(false);
  }

  function bindEvents() {
    els.btnSettings.addEventListener('click', openSettings);

    // 로그인 게이트
    if (els.authForm) els.authForm.addEventListener('submit', submitAuth);
    if (els.authLocalBtn) els.authLocalBtn.addEventListener('click', function () {
      if (cloudConfigured()) return;   // config 가 있는 배포에서는 로컬 모드로 빠져나갈 수 없다
      els.authGate.classList.remove('open');
      document.body.classList.remove('auth-locked');
    });
    if (els.setSignOut) els.setSignOut.addEventListener('click', function () {
      var ok = window.confirm('로그아웃할까요?\n이 기기에 저장된 메모 캐시가 지워지고, 다시 로그인하면 서버에서 내려받아요.');
      if (!ok) return;
      closeSettings();
      Store.signOut().then(function () {
        hideAuthError();
        setAuthBusy(false);
        blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
        blobUrls.clear();
        state.pending = [];
        renderPending();
        updateAuthGate(Store.getAuthState());
        toast('로그아웃했어요');
      });
    });
    els.btnSearch.addEventListener('click', function () {
      state.searchOpen = !state.searchOpen;
      els.searchRow.classList.toggle('hidden', !state.searchOpen);
      if (state.searchOpen) setTimeout(function () { els.searchInput.focus(); }, 30);
      else { els.searchInput.value = ''; state.query = ''; render(); }
    });
    els.searchInput.addEventListener('input', function () {
      state.query = els.searchInput.value;
      els.btnClearSearch.classList.toggle('hidden', !state.query);
      render();
    });
    els.btnClearSearch.addEventListener('click', function () {
      els.searchInput.value = '';
      state.query = '';
      els.btnClearSearch.classList.add('hidden');
      els.searchInput.focus();
      render();
    });

    els.viewTabs.addEventListener('click', function (e) {
      var b = e.target.closest('.vt');
      if (b) setView(b.getAttribute('data-view'));
    });

    els.btnAttach.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files && els.fileInput.files.length) addFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    els.btnTag.addEventListener('click', function () {
      var start = els.input.selectionStart || 0;
      var v = els.input.value;
      els.input.value = v.slice(0, start) + '#' + v.slice(start);
      els.input.setSelectionRange(start + 1, start + 1);
      els.input.focus();
      autoGrow();
      updateTagSuggest();
    });

    els.btnSend.addEventListener('click', send);
    els.input.addEventListener('input', function () { autoGrow(); updateTagSuggest(); updateLinkCatBar(); });
    els.input.addEventListener('click', updateTagSuggest);
    els.input.addEventListener('blur', function () { setTimeout(hideTagSuggest, 120); });

    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); send(); return; }
        if (e.shiftKey && state.settings.shiftEnterSend) { e.preventDefault(); send(); return; }
        // 기본: 줄바꿈 (카카오톡 모바일과 동일)
      }
      if (e.key === 'Escape') hideTagSuggest();
    });

    els.jumpLatest.addEventListener('click', function () { scrollToBottom(true); });
    els.scroller.addEventListener('scroll', function () {
      els.jumpLatest.classList.toggle('hidden', isNearBottom() || state.view !== 'memo');
    });

    // 붙여넣기 이미지
    document.addEventListener('paste', function (e) {
      if (els.lock.classList.contains('open')) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    // 드래그 앤 드롭
    ['dragenter'].forEach(function (ev) {
      els.app.addEventListener(ev, function (e) {
        if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
        e.preventDefault();
        state.dragDepth++;
        els.dropZone.classList.add('show');
      });
    });
    els.app.addEventListener('dragover', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    els.app.addEventListener('dragleave', function (e) {
      if (!e.dataTransfer) return;
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) els.dropZone.classList.remove('show');
    });
    els.app.addEventListener('drop', function (e) {
      if (!e.dataTransfer) return;
      e.preventDefault();
      state.dragDepth = 0;
      els.dropZone.classList.remove('show');
      if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // 시트 닫기
    els.sheet.addEventListener('click', function (e) {
      if (e.target === els.sheet || e.target.closest('[data-close]')) closeSheet();
    });
    els.settings.addEventListener('click', function (e) {
      if (e.target === els.settings || e.target.closest('[data-close]')) closeSettings();
    });

    // 라이트박스
    els.lbClose.addEventListener('click', closeLightbox);
    if (els.lbCat) els.lbCat.addEventListener('click', function (e) {
      e.stopPropagation();
      var lb = state.lightbox;
      if (!lb) return;
      var img = (lb.memo.images || [])[lb.i];
      openPhotoCategorySheet(lb.memo, img ? img.key : null);
    });
    els.lbPrev.addEventListener('click', function (e) { e.stopPropagation(); lbStep(-1); });
    els.lbNext.addEventListener('click', function (e) { e.stopPropagation(); lbStep(1); });
    els.lbImg.addEventListener('click', function (e) {
      e.stopPropagation();
      els.lbImg.classList.toggle('zoomed');
    });
    els.lbStage.addEventListener('click', function (e) {
      if (e.target === els.lbStage) closeLightbox();
    });
    els.lbStage.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      state.swipeX = t.clientX;
      state.swipeY = t.clientY;
    }, { passive: true });
    els.lbStage.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0];
      var dx = t.clientX - (state.swipeX || 0);
      var dy = t.clientY - (state.swipeY || 0);
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) lbStep(1); else lbStep(-1);
      }
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (els.lightbox.classList.contains('open')) closeLightbox();
        else if (els.sheet.classList.contains('open')) closeSheet();
        else if (els.settings.classList.contains('open')) closeSettings();
      }
      if (els.lightbox.classList.contains('open')) {
        if (e.key === 'ArrowLeft') lbStep(-1);
        if (e.key === 'ArrowRight') lbStep(1);
      }
    });

    // 설정 항목
    $$('input[name="quality"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.settings.imageQuality = r.value;
        saveSettings();
        renderSettings();
        renderPending();
      });
    });

    els.shiftEnter.addEventListener('change', function () {
      state.settings.shiftEnterSend = els.shiftEnter.checked;
      saveSettings();
      toast(els.shiftEnter.checked ? 'Shift+Enter 로 전송해요' : 'Enter·Shift+Enter 모두 줄바꿈이에요');
    });

    els.autoLock.addEventListener('change', function () {
      state.settings.autoLockMin = Number(els.autoLock.value);
      saveSettings();
    });

    els.setSyncNow.addEventListener('click', function () {
      if (!Store.isCloud()) { toast('config.js 에 Supabase 정보를 넣어주세요'); return; }
      els.setSyncNow.disabled = true;
      Store.sync().catch(function () {}).then(function () {
        els.setSyncNow.disabled = false;
        renderSettings();
        toast('동기화 완료');
      });
    });

    els.setPinBtn.addEventListener('click', setupPin);
    els.btnLockNow.addEventListener('click', function () {
      if (!getPin()) { toast('PIN을 먼저 설정해 주세요'); return; }
      closeSettings();
      showLock();
    });

    els.setExport.addEventListener('click', function () {
      var data = JSON.stringify(Store.exportJson(), null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var d = new Date();
      a.href = url;
      a.download = 'memo-backup-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('JSON 백업을 내려받았어요');
    });

    // 서비스 워커 : 새 버전이 제어를 갖으면 한 번 새로고침해 구버전 캐시에 잡히지 않게 한다
    if ('serviceWorker' in navigator) {
      var swHadController = !!navigator.serviceWorker.controller;
      var swReloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!swHadController || swReloading) return;   // 첫 설치 등 이전 컨트롤러가 없으면 새로고침하지 않는다
        swReloading = true;
        var busy = (els.input && els.input.value.trim()) || state.pending.length;
        if (busy) { toast('새 버전이 준비됐어요 · 설정 → 캐시 지우고 새로고침'); return; }
        location.reload();
      });
    }

    // 캐시 지우고 새로고침 (메모 데이터는 IndexedDB·클라우드에 있어 지워지지 않는다)
    if (els.setCacheReset) els.setCacheReset.addEventListener('click', function () {
      els.setCacheReset.disabled = true;
      var jobs = [];
      if ('caches' in window) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
      if ('serviceWorker' in navigator) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }));
      }
      Promise.all(jobs).catch(function () { /* ignore */ }).then(function () {
        location.reload();
      });
    });

    els.setClear.addEventListener('click', function () {
      var ok = window.confirm('모든 메모를 삭제할까요?\n(사진 파일도 함께 지워지고, 클라우드 동기화 중이면 다른 기기에서도 사라집니다)');
      if (!ok) return;
      Store.clearAll().then(function () {
        blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
        blobUrls.clear();
        closeSettings();
        render();
        toast('모두 삭제했어요');
      });
    });

    els.setInstall.addEventListener('click', function () {
      if (!state.installEvent) return;
      state.installEvent.prompt();
      state.installEvent.userChoice.then(function () { state.installEvent = null; renderSettings(); });
    });

    // PIN 키패드
    els.keypad.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var k = b.getAttribute('data-key');
      if (k === 'back') lockBackspace();
      else if (k === 'ok') tryUnlock();
      else if (k) lockDigit(k);
    });
    document.addEventListener('keydown', function (e) {
      if (!els.lock.classList.contains('open')) return;
      if (/^[0-9]$/.test(e.key)) lockDigit(e.key);
      else if (e.key === 'Backspace') { e.preventDefault(); lockBackspace(); }
      else if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
    });

    // 자동 잠금
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt && getPin() && state.settings.autoLockMin > 0) {
        if (Date.now() - hiddenAt > state.settings.autoLockMin * 60000) showLock();
        hiddenAt = 0;
      }
    });

    // 설치 프롬프트
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      state.installEvent = e;
      if (state.settingsOpen) renderSettings();
    });

    // 서비스 워커
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
          if (reg && reg.update) reg.update().catch(function () { /* ignore */ });
        }).catch(function (err) {
          console.warn('[memo] service worker 등록 실패', err);
        });
      });
    }

    // 저장소 변경 반영
    Store.subscribe(function (memos) {
      var a = Store.getAuthState ? Store.getAuthState() : { required: false, signedIn: true };
      if (a.required && !a.signedIn) return;   // 로그인 전에는 메모를 화면에 올리지 않는다
      var near = isNearBottom();
      state.memos = memos;
      render();
      if (near && state.view !== 'timeline') scrollToBottom(false);
    });

    Store.onStatus(function (st) {
      var cls = 'local';
      var txt = '로컬';
      if (st.state === 'signedout') { cls = 'off'; txt = '로그인'; }
      else if (st.state === 'signing') { cls = 'syncing'; txt = '로그인 중'; }
      else if (st.state === 'syncing') { cls = 'syncing'; txt = '동기화 중'; }
      else if (st.state === 'synced') { cls = 'ok'; txt = '동기화됨'; }
      else if (st.state === 'offline') { cls = 'off'; txt = '오프라인'; }
      else if (st.state === 'error') { cls = 'err'; txt = '오류'; }

      els.syncBadge.className = 'sync-badge ' + cls;
      els.syncText.textContent = txt;
      els.syncBadge.title = st.state === 'synced' && st.lastSync
        ? '마지막 동기화 ' + U.timeLabel(st.lastSync)
        : (st.error || st.text);

      if (state.settingsOpen) renderSettings();
    });

    if (Store.onAuth) {
      Store.onAuth(function (a) {
        updateAuthGate(a);
        if (a.signedIn) {
          state.memos = Store.getMemos();
          render();
          scrollToBottom(false);
        } else {
          blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
          blobUrls.clear();
          state.memos = [];
          state.query = '';
          state.tag = null;
          state.memoCat = null;
          state.view = 'photos';
          if (els.searchInput) els.searchInput.value = '';
          syncViewTabs();
          // 로그인 전 화면에 메모가 남지 않도록 DOM 까지 비운다
          els.timeline.innerHTML = '';
          els.altView.innerHTML = '';
          els.pinnedSection.innerHTML = '';
          els.tagbar.innerHTML = '';
          if (els.memoCatRow) els.memoCatRow.innerHTML = '';
          els.countBadge.textContent = '';
        }
        if (state.settingsOpen) renderSettings();
      });
    }
  }

  /* ---------------------------------------------------------- */
  /* 시작                                                       */
  /* ---------------------------------------------------------- */

  function cacheEls() {
    els.app = $('#app');
    els.scroller = $('#scroller');
    els.timeline = $('#timeline');
    els.altView = $('#altView');
    els.pinnedSection = $('#pinnedSection');
    els.tagbar = $('#tagbar');
    els.tagbarWrap = $('.tagbar-wrap');
    els.memoCatRow = $('#memoCatRow');
    els.jumpLatest = $('#jumpLatest');
    els.syncBadge = $('#syncBadge');
    els.syncText = $('#syncText');
    els.countBadge = $('#countBadge');
    els.btnSettings = $('#btnSettings');
    els.btnSearch = $('#btnSearch');
    els.searchRow = $('#searchRow');
    els.searchInput = $('#searchInput');
    els.btnClearSearch = $('#btnClearSearch');
    els.viewTabs = $('#viewTabs');
    els.input = $('#input');
    els.btnSend = $('#btnSend');
    els.btnAttach = $('#btnAttach');
    els.btnTag = $('#btnTag');
    els.fileInput = $('#fileInput');
    els.pendingTray = $('#pendingTray');
    els.linkCatBar = $('#linkCatBar');
    els.photoCatBar = $('#photoCatBar');
    els.memoCatBar = $('#memoCatBar');
    els.tagSuggest = $('#tagSuggest');
    els.dropZone = $('#dropZone');
    els.sheet = $('#sheet');
    els.sheetActions = $('#sheetActions');
    els.sheetTitle = $('#sheetTitle');
    els.settings = $('#settings');
    els.setSyncInfo = $('#setSyncInfo');
    els.setSyncNow = $('#setSyncNow');
    els.shiftEnter = $('#setShiftEnter');
    els.autoLock = $('#setAutoLock');
    els.setImageNote = $('#setImageNote');
    els.setPinBtn = $('#setPinBtn');
    els.setPinState = $('#setPinState');
    els.btnLockNow = $('#btnLockNow');
    els.setExport = $('#setExport');
    els.setClear = $('#setClear');
    els.setCacheReset = $('#setCacheReset');
    els.setInstall = $('#setInstall');
    els.setVersion = $('#setVersion');
    els.lightbox = $('#lightbox');
    els.lbImg = $('#lbImg');
    els.lbCounter = $('#lbCounter');
    els.lbDownload = $('#lbDownload');
    els.lbClose = $('#lbClose');
    els.lbPrev = $('#lbPrev');
    els.lbNext = $('#lbNext');
    els.lbCat = $('#lbCat');
    els.lbStage = $('#lbStage');
    els.toast = $('#toast');
    els.lock = $('#lock');
    els.lockDots = $('#lockDots');
    els.lockMsg = $('#lockMsg');
    els.lockInput = $('#lockInput');
    els.keypad = $('#keypad');

    els.authGate = $('#authGate');
    els.authForm = $('#authForm');
    els.authEmail = $('#authEmail');
    els.authPass = $('#authPass');
    els.authKeep = $('#authKeep');
    els.authSubmit = $('#authSubmit');
    els.authError = $('#authError');
    els.authLocalBtn = $('#authLocalBtn');
    els.setAccount = $('#setAccount');
    els.setAccountNote = $('#setAccountNote');
    els.setSignOut = $('#setSignOut');
  }

  function boot() {
    cacheEls();
    bindEvents();
    autoGrow();
    renderPinDots();
    syncViewTabs();
    updateMemoCatBar();
    updateLinkCatBar();

    // config 가 설정돼 있으면 로그인 전까지 메모 화면을 가린다
    if (cloudConfigured()) {
      if (els.authGate) els.authGate.classList.add('open');
      document.body.classList.add('auth-locked');
    }
    if (els.authLocalBtn) els.authLocalBtn.classList.toggle('hidden', cloudConfigured());

    Store.init().then(function (memos) {
      state.memos = memos || [];
      var a = Store.getAuthState ? Store.getAuthState() : { required: false, signedIn: true };
      updateAuthGate(a);
      if (!a.required || a.signedIn) {
        render();
        scrollToBottom(false);
        if (getPin()) showLock();
      }
    }).catch(function (err) {
      console.error('[memo] init failed', err);
      if (cloudConfigured()) {
        showAuthError('서버에 연결하지 못했어요 — 주소와 네트워크를 확인해 주세요');
      } else {
        els.timeline.appendChild(emptyState('timeline'));
      }
    });

    window.__memoBooted = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
