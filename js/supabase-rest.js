/* ============================================================
 * supabase-rest.js — supabase-js 없이 fetch 만으로 쓰는 최소 클라이언트
 *  · 인증   : Auth    (/auth/v1/token, /auth/v1/logout) — 이메일·비밀번호
 *  · 데이터 : PostgREST (/rest/v1/...)                  — Bearer access token
 *  · 이미지 : Storage  (/storage/v1/object/authenticated/...) — 비공개 버킷
 *
 *  세션( access_token / refresh_token / expires_at / user )은
 *  localStorage(또는 '로그인 유지' 해제 시 sessionStorage)에 저장하고,
 *  만료 60초 전이거나 401 응답을 받으면 스스로 refresh 한다.
 *  토큰 값은 화면/콘솔에 찍지 않는다.
 * ============================================================ */
(function () {
  'use strict';

  var SESSION_KEY = 'memo.session.v1';
  var REFRESH_SKEW = 60; // 만료 몇 초 전부터 미리 갱신할지

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* ---------- 세션 저장소 ---------- */

  function storageOf(persist) {
    try {
      return persist === 'session' ? window.sessionStorage : window.localStorage;
    } catch (e) { return null; }
  }

  function loadSession() {
    var kinds = ['sessionStorage', 'localStorage'];
    for (var i = 0; i < kinds.length; i++) {
      var raw = null;
      try { raw = window[kinds[i]].getItem(SESSION_KEY); } catch (e) { raw = null; }
      if (!raw) continue;
      var s = parseJson(raw);
      if (s && s.access_token) {
        if (!s.persist) s.persist = kinds[i] === 'sessionStorage' ? 'session' : 'local';
        return s;
      }
    }
    return null;
  }

  function clearStored() {
    ['localStorage', 'sessionStorage'].forEach(function (k) {
      try { window[k].removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    });
  }

  function cloneSession(s) {
    if (!s) return null;
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token || '',
      expires_at: Number(s.expires_at || 0),
      token_type: s.token_type || 'bearer',
      user: s.user ? { id: s.user.id, email: s.user.email || '' } : null
    };
  }

  function normalizeSession(payload, prev) {
    if (!payload || !payload.access_token) return null;
    var user = payload.user || (prev && prev.user) || null;
    var expiresAt = Number(payload.expires_at || 0);
    if (!expiresAt && payload.expires_in) expiresAt = nowSec() + Number(payload.expires_in);
    if (!expiresAt) expiresAt = nowSec() + 3600;
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || (prev && prev.refresh_token) || '',
      expires_at: expiresAt,
      token_type: payload.token_type || 'bearer',
      persist: (prev && prev.persist) || 'local',
      user: user && user.id ? { id: user.id, email: user.email || '' } : null
    };
  }

  /* ---------- 에러 메시지 (사용자에게 보여줄 한국어) ---------- */

  function authError(status, text) {
    var j = parseJson(text) || {};
    var code = j.error_code || j.error || '';
    var desc = j.error_description || j.msg || j.message || '';
    var msg;

    if (code === 'invalid_grant' || /invalid login credentials/i.test(desc)) {
      msg = '이메일 또는 비밀번호가 맞지 않아요';
    } else if (code === 'email_not_confirmed' || /email not confirmed/i.test(desc)) {
      msg = '이메일 확인이 필요해요 — 대시보드 Authentication → Users 에서 Confirm 해 주세요';
    } else if (status === 422 || code === 'validation_failed') {
      msg = '이메일 형식과 비밀번호를 확인해 주세요';
    } else if (status === 429) {
      msg = '시도가 너무 많아요. 잠시 후 다시 시도해 주세요';
    } else if (status === 401) {
      msg = '로그인 세션이 만료됐어요. 다시 로그인해 주세요';
    } else if (status >= 500) {
      msg = 'Supabase 서버 오류(' + status + ') — 잠시 후 다시 시도해 주세요';
    } else {
      msg = '로그인하지 못했어요 (' + status + (desc ? ' — ' + String(desc).slice(0, 120) : '') + ')';
    }
    var e = new Error(msg);
    e.status = status;
    e.code = code;
    return e;
  }

  function httpError(status, text) {
    var j = parseJson(text) || {};
    var msg = 'Supabase ' + status + ' — ' + (j.message || j.error_description || j.error || String(text || '').slice(0, 300));
    var e = new Error(msg);
    e.status = status;
    return e;
  }

  function offlineError(e) {
    var err = new Error('Supabase 에 연결하지 못했어요 — 주소와 네트워크를 확인해 주세요');
    err.network = true;
    err.cause = e;
    return err;
  }

  /* ============================================================ */

  window.SbRest = function (url, key, table, bucket) {
    var base = String(url || '').replace(/\/+$/, '');
    var apikey = String(key || '');
    var t = table || 'memos';
    var b = bucket || 'memo-images';

    var session = loadSession();
    var listeners = [];
    var refreshing = null;

    function notify() {
      var snapshot = session ? cloneSession(session) : null;
      listeners.slice().forEach(function (fn) {
        try { fn(snapshot); } catch (e) { console.error(e); }
      });
    }

    function saveSession() {
      if (!session) return;
      var store = storageOf(session.persist);
      var other = storageOf(session.persist === 'session' ? 'local' : 'session');
      try { if (other) other.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
      try { if (store) store.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
    }

    function clearSession() {
      session = null;
      clearStored();
    }

    /* ---------- Auth 요청 ---------- */

    function authRequest(path, body, opts) {
      var o = opts || {};
      var headers = { apikey: apikey, 'Content-Type': 'application/json' };
      if (o.token) headers.Authorization = 'Bearer ' + o.token;

      return fetch(base + path, {
        method: o.method || 'POST',
        headers: headers,
        body: body == null ? undefined : JSON.stringify(body)
      }).catch(function (e) { throw offlineError(e); })
        .then(function (res) {
          if (res.ok || res.status === 204) return res;
          return res.text().then(function (txt) { throw authError(res.status, txt); });
        });
    }

    function signInWithPassword(email, password, opts) {
      var persist = opts && opts.persist === 'session' ? 'session' : 'local';
      return authRequest('/auth/v1/token?grant_type=password', {
        email: String(email || '').trim(),
        password: String(password || '')
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          var next = normalizeSession(data, null);
          if (!next || !next.user) throw new Error('로그인 응답에 사용자 정보가 없어요');
          next.persist = persist;
          session = next;
          saveSession();
          notify();
          return cloneSession(session);
        });
    }

    function doRefresh(token) {
      var rt = token || (session && session.refresh_token);
      if (!rt) {
        clearSession();
        var e = new Error('로그인 세션이 만료됐어요. 다시 로그인해 주세요');
        e.status = 401;
        return Promise.reject(e);
      }
      return authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: rt })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var prev = session;
          var next = normalizeSession(data, prev);
          if (!next) throw new Error('세션을 갱신하지 못했어요');
          next.persist = (prev && prev.persist) || 'local';
          session = next;
          saveSession();
          notify();
          return cloneSession(session);
        })
        .catch(function (err) {
          // refresh_token 자체가 거부되면 세션 종료 → 앱은 로그인 화면으로
          if (!err || !err.network) { clearSession(); notify(); }
          throw err;
        });
    }

    function refreshSession(token) {
      if (refreshing) return refreshing;
      refreshing = doRefresh(token).then(function (s) {
        refreshing = null;
        return s;
      }, function (e) {
        refreshing = null;
        throw e;
      });
      return refreshing;
    }

    function restoreSession() {
      if (!session) return Promise.resolve(null);
      var exp = Number(session.expires_at || 0);
      if (!exp || exp - REFRESH_SKEW > nowSec()) return Promise.resolve(cloneSession(session));
      if (!session.refresh_token) {
        clearSession();
        notify();
        return Promise.resolve(null);
      }
      return refreshSession().then(function (s) { return s; }, function () { return null; });
    }

    function signOut(accessToken) {
      var token = accessToken || (session && session.access_token);
      var call = token
        ? authRequest('/auth/v1/logout', null, { method: 'POST', token: token }).catch(function () { return null; })
        : Promise.resolve(null);
      return call.then(function () {
        clearSession();
        notify();
        return true;
      });
    }

    /* ---------- 인증이 붙은 데이터 요청 ---------- */

    function ensureToken(force) {
      if (!session) {
        var e = new Error('로그인이 필요해요');
        e.status = 401;
        return Promise.reject(e);
      }
      var exp = Number(session.expires_at || 0);
      var fresh = !exp || exp - REFRESH_SKEW > nowSec();
      if (!force && fresh) return Promise.resolve(cloneSession(session));
      if (!session.refresh_token) {
        if (!force && exp > nowSec()) return Promise.resolve(cloneSession(session));
        clearSession();
        notify();
        var err = new Error('로그인 세션이 만료됐어요. 다시 로그인해 주세요');
        err.status = 401;
        return Promise.reject(err);
      }
      return refreshSession();
    }

    function authedFetch(path, opts, retried) {
      return ensureToken(!!retried).then(function (s) {
        var headers = Object.assign({}, (opts && opts.headers) || {});
        headers.apikey = apikey;
        headers.Authorization = 'Bearer ' + s.access_token;
        return fetch(base + path, Object.assign({}, opts || {}, { headers: headers }))
          .catch(function (e) { throw offlineError(e); })
          .then(function (res) {
            if (res.status === 401 && !retried) {
              return refreshSession().then(function () { return authedFetch(path, opts, true); });
            }
            return res;
          });
      });
    }

    function request(path, opts) {
      return authedFetch(path, opts, false).then(function (res) {
        if (res.ok) return res;
        return res.text().then(function (detail) { throw httpError(res.status, detail); });
      });
    }

    return {
      baseUrl: base,

      auth: {
        signIn: signInWithPassword,
        signInWithPassword: signInWithPassword,
        refreshSession: refreshSession,
        restore: restoreSession,
        signOut: signOut,
        getSession: function () { return session ? cloneSession(session) : null; },
        hasSession: function () {
          if (!session) return false;
          var exp = Number(session.expires_at || 0);
          return !exp || exp > nowSec() || !!session.refresh_token;
        },
        userId: function () { return session && session.user ? session.user.id : ''; },
        email: function () { return session && session.user ? session.user.email : ''; },
        accessToken: function () { return session ? session.access_token : ''; },
        onChange: function (fn) {
          listeners.push(fn);
          return function () {
            var i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
          };
        }
      },

      ping: function () {
        return request('/rest/v1/' + t + '?select=id&limit=1').then(function () { return true; });
      },

      pull: function (sinceIso) {
        var out = [];
        var pageSize = 500;

        function page(offset) {
          var params = new URLSearchParams();
          params.set('select', '*');
          params.set('order', 'updated_at.asc');
          params.set('limit', String(pageSize));
          params.set('offset', String(offset));
          if (sinceIso) params.set('updated_at', 'gt.' + sinceIso);

          return request('/rest/v1/' + t + '?' + params.toString())
            .then(function (res) { return res.json(); })
            .then(function (rows) {
              if (!Array.isArray(rows)) return out;
              out = out.concat(rows);
              if (rows.length < pageSize || out.length > 20000) return out;
              return page(offset + pageSize);
            });
        }

        return page(0);
      },

      upsert: function (rows) {
        return request('/rest/v1/' + t + '?on_conflict=id', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(rows)
        }).then(function () { return true; });
      },

      /* 비공개 버킷 업로드 → 저장된 경로를 돌려준다 (공개 URL 은 없다) */
      upload: function (path, blob, contentType) {
        return request('/storage/v1/object/' + b + '/' + encodeURI(path), {
          method: 'POST',
          headers: {
            'Content-Type': contentType || (blob && blob.type) || 'application/octet-stream',
            'cache-control': 'max-age=31536000',
            'x-upsert': 'true'
          },
          body: blob
        }).then(function () { return path; });
      },

      /* 비공개 버킷 다운로드 — Bearer 토큰이 없으면 400/401 */
      download: function (path) {
        return request('/storage/v1/object/authenticated/' + b + '/' + encodeURI(path), {
          method: 'GET',
          headers: { 'cache-control': 'no-cache' }
        }).then(function (res) { return res.blob(); });
      },

      remove: function (paths) {
        if (!paths || !paths.length) return Promise.resolve(true);
        return request('/storage/v1/object/' + b, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths })
        }).then(function () { return true; });
      }
    };
  };
})();
