/*
 * Surge http-response 脚本：自动捕获 dmit.io 的登录 Cookie（支持多账号）
 *
 * 配合 MITM 使用。用户登录 dmit.io 时，把 Set-Cookie 按「会话」分别存入
 * 多个 cookie jar，供面板脚本查询所有账号的 VPS 流量。
 *
 * 会话识别：WHMCS 会话 cookie（名字含 whmcs 且不是 WHMCSUser）的值。
 * 值不同 = 不同账号，各自存一个 jar；cf_clearance 等通用 cookie 同步到所有 jar。
 *
 * 存储键：
 *   dmit_cookie_jars   JSON 数组 [{s: 会话值, c: cookie串}]，最多 5 个
 *   dmit_ua            浏览器 User-Agent
 */

const JARS_KEY = "dmit_cookie_jars";
const UA_KEY = "dmit_ua";
const MAX_JARS = 5;

function headerValue(headers, name) {
  if (!headers) return "";
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i++) {
      if (String(headers[i].field || "").toLowerCase() === name) {
        return headers[i].value;
      }
    }
    return "";
  }
  for (const k in headers) {
    if (k.toLowerCase() === name) return headers[k];
  }
  return "";
}

function parseCookie(setCookie) {
  const first = String(setCookie || "").split(";")[0].trim();
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

function parseCookieString(str) {
  const jar = {};
  String(str || "")
    .split(";")
    .forEach((p) => {
      const eq = p.indexOf("=");
      if (eq > 0) jar[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    });
  return jar;
}

function cookieStringFrom(jar) {
  return Object.keys(jar)
    .map((k) => `${k}=${jar[k]}`)
    .join("; ");
}

// 返回 WHMCS 会话 cookie 的值（排除 WHMCSUser 这种"记住我"cookie）；
// deleted/expired/空 视为登出态，返回空。
function sessionValueFrom(jar) {
  for (const k in jar) {
    const lower = k.toLowerCase();
    if (lower.indexOf("whmcs") >= 0 && lower !== "whmcsuser") {
      const v = jar[k];
      if (v && v !== "deleted" && v !== "expired") return v;
      return "";
    }
  }
  return "";
}

function mergeInto(existing, newCookies) {
  const jar = parseCookieString(existing);
  for (const k in newCookies) {
    const v = newCookies[k];
    if (v === "deleted" || v === "" || v === "expired") delete jar[k];
    else jar[k] = v;
  }
  return cookieStringFrom(jar);
}

function loadJars() {
  const raw = $persistentStore.read(JARS_KEY) || "";
  try {
    const a = JSON.parse(raw);
    if (Array.isArray(a)) return a;
  } catch (_) {}
  const old = ($persistentStore.read("dmit_cookie_jar") || "").trim();
  if (old) return [{ s: sessionValueFrom(parseCookieString(old)), c: old }];
  return [];
}

function saveJars(jars) {
  $persistentStore.write(JSON.stringify(jars), JARS_KEY);
}

// 1) 记录浏览器 UA
const ua = headerValue(typeof $request !== "undefined" ? $request.headers : null, "user-agent");
if (ua) {
  $persistentStore.write(String(ua), UA_KEY);
}

// 2) 解析本次响应的 Set-Cookie
const responseHeaders =
  typeof $response !== "undefined" ? ($response.headers || []) : [];
const hdrs = Array.isArray(responseHeaders)
  ? responseHeaders
  : Object.keys(responseHeaders).map((k) => ({ field: k, value: responseHeaders[k] }));

const newCookies = {};
let hasSetCookie = false;
hdrs.forEach((h) => {
  if (String(h.field || "").toLowerCase() !== "set-cookie") return;
  const c = parseCookie(h.value);
  if (!c) return;
  newCookies[c.name] = c.value;
  hasSetCookie = true;
});

if (hasSetCookie) {
  const sv = sessionValueFrom(newCookies);

  // 通用 cookie（cf_clearance 等），全账号共享
  const common = {};
  for (const k in newCookies) {
    if (k.toLowerCase().indexOf("whmcs") < 0) common[k] = newCookies[k];
  }

  let jars = loadJars();
  let addedNew = false;

  if (sv) {
    let target = null;
    for (const j of jars) {
      if (j && j.s === sv) {
        target = j;
        break;
      }
    }

    if (target) {
      target.c = mergeInto(target.c, newCookies);
    } else {
      // 新账号：继承已有 jar 里的通用 cookie（cf_clearance 等），避免被 Cloudflare 拦
      const base = {};
      if (jars.length) {
        const last = parseCookieString(jars[jars.length - 1].c);
        for (const k in last) {
          if (k.toLowerCase().indexOf("whmcs") < 0) base[k] = last[k];
        }
      }
      for (const k in newCookies) base[k] = newCookies[k];
      const nj = { s: sv, c: cookieStringFrom(base) };
      jars.push(nj);
      target = nj;
      addedNew = true;
    }

    // 本次响应的通用 cookie 同步到其它 jar，保持 cf_clearance 新鲜
    if (Object.keys(common).length) {
      jars.forEach((j) => {
        if (j !== target) j.c = mergeInto(j.c, common);
      });
    }
  } else if (Object.keys(common).length) {
    jars.forEach((j) => {
      j.c = mergeInto(j.c, common);
    });
  }

  if (jars.length > MAX_JARS) jars = jars.slice(-MAX_JARS);
  saveJars(jars);

  if (addedNew) {
    $notification.post(
      "DMIT Cookie 已捕获",
      "检测到新的登录会话",
      "回 Surge 面板刷新即可合并显示所有账号"
    );
  }
}

$done({});
