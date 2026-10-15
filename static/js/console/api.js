/**
 * 接口客户端与会话。
 *
 * 后端约定（读自 app/main.py 与中间件源码，非推断）：
 *  · 响应统一包成 { code, message, data }，且响应体的键被 camelcase 中间件
 *    转成小驼峰；请求体必须保持 snake_case。
 *  · 业务失败也可能以 HTTP 200 + code!=200 返回（如 auth 登录失败），
 *    所以判定成败必须看 body.code，不能只看 res.ok。
 *  · 缺少/过期令牌时由中间件返回 HTTP 401。
 */

const TOKEN_KEY = "ea.token";
const SESSION_KEY = "ea.session";

export class ApiError extends Error {
  constructor(message, code, details) {
    super(message || "请求失败");
    this.name = "ApiError";
    this.code = code == null ? 0 : code;
    this.details = details;
  }
}

/* ---------------- 会话 ---------------- */

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ""; },
  get user() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null") || null; }
    catch (_) { return null; }
  },
  get role() { return (this.user && this.user.role) || ""; },
  get id() { const u = this.user; return u && u.id != null ? u.id : null; },
  get name() { const u = this.user; return (u && (u.displayName || u.username)) || ""; },
  save(data) {
    localStorage.setItem(TOKEN_KEY, data.token || "");
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        id: data.id == null ? null : data.id,
        username: data.username,
        displayName: data.displayName || data.username,
        role: String(data.role || "").toUpperCase(),
        expiresIn: data.expiresIn || null,
        at: Date.now(),
      })
    );
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
  },
};

export function loginUrl(next) {
  return "/login.html?next=" + encodeURIComponent(next || "/platform");
}

/* ---------------- 请求 ---------------- */

async function request(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers);
  const hasBody = opts.body !== undefined && opts.body !== null;
  if (hasBody && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (session.token) headers.Authorization = "Bearer " + session.token;

  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body: hasBody
        ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body))
        : undefined,
    });
  } catch (err) {
    throw new ApiError("暂时连不上平台：" + (err.message || err), -1);
  }

  let body = null;
  const ctype = res.headers.get("content-type") || "";
  if (ctype.indexOf("application/json") >= 0) {
    try { body = await res.json(); } catch (_) { body = null; }
  } else if (res.status !== 204) {
    const text = await res.text();
    body = text ? { code: res.status, message: text.slice(0, 300), data: null } : null;
  }

  const code = body && body.code != null ? body.code : res.status;
  const message = (body && body.message) || res.statusText || "请求失败";

  if (!res.ok || (body && body.code != null && body.code !== 200)) {
    const authed = !!session.token;
    const isAuthCall = path.indexOf("/api/auth/") === 0;
    if ((res.status === 401 || code === 401) && authed && !isAuthCall && !opts.silentAuth) {
      session.clear();
      const back = location.pathname + location.search;
      window.location.replace(loginUrl(back));
    }
    throw new ApiError(message, code, body && body.details);
  }

  // 绝大多数接口返回 {code, message, data} 信封；/api/health 这类是裸对象，
  // 没有 code 字段，直接原样返回，否则调用方拿到的是 undefined。
  const enveloped = body && Object.prototype.hasOwnProperty.call(body, "code");
  return enveloped ? body.data : body;
}

export const api = {
  get: (p, o) => request(p, Object.assign({ method: "GET" }, o)),
  post: (p, body, o) => request(p, Object.assign({ method: "POST", body }, o)),
  put: (p, body, o) => request(p, Object.assign({ method: "PUT", body }, o)),
  del: (p, o) => request(p, Object.assign({ method: "DELETE" }, o)),
  raw: request,
};

/* ---------------- 认证 ---------------- */

export function login(username, password, role) {
  // 请求体保持 snake_case；成功时写会话
  return request("/api/auth/login", {
    method: "POST",
    silentAuth: true,
    body: { username, password, role },
  }).then((data) => { session.save(data); return data; });
}

export function register(payload) {
  return request("/api/auth/register", {
    method: "POST",
    silentAuth: true,
    body: {
      username: payload.username,
      password: payload.password,
      display_name: payload.displayName || payload.username,
      email: payload.email || null,
      role: payload.role,
    },
  });
}

export function forgotPassword(payload) {
  return request("/api/auth/forgot-password", {
    method: "POST",
    silentAuth: true,
    body: {
      username: payload.username,
      role: payload.role,
      email: payload.email || null,
      new_password: payload.newPassword,
    },
  });
}

export function logout() {
  session.clear();
  window.location.replace(loginUrl());
}

export function health() {
  return request("/api/health");
}

/**
 * 通知长连接：ws(s)://host<path>?token=…，断线按退避重连。
 * path 默认 /ws/notifications；态势模块传 /api/situation/alerts/stream（同源别名通道）。
 */
export function openNotificationStream(handlers, path) {
  const h = handlers || {};
  let ws = null, closed = false, attempts = 0, timer = null;

  function connect() {
    if (closed || !session.token) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + (path || "/ws/notifications") + "?token=" + encodeURIComponent(session.token);
    try { ws = new WebSocket(url); } catch (_) { schedule(); return; }

    ws.onopen = () => { attempts = 0; h.onOpen && h.onOpen(); };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { msg = { type: "raw", payload: ev.data }; }
      h.onMessage && h.onMessage(msg);
    };
    ws.onclose = () => { ws = null; h.onClose && h.onClose(); schedule(); };
    ws.onerror = () => { try { ws && ws.close(); } catch (_) {} };
  }

  function schedule() {
    if (closed) return;
    attempts++;
    const wait = Math.min(30000, 1200 * Math.pow(1.7, Math.min(attempts, 6)));
    clearTimeout(timer);
    timer = setTimeout(connect, wait);
  }

  connect();
  return {
    close() { closed = true; clearTimeout(timer); try { ws && ws.close(); } catch (_) {} },
  };
}
