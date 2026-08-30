/*
 * Surge http-response 脚本：自动捕获 dmit.io 的登录 Cookie
 *
 * 配合 MITM 使用。用户用浏览器正常登录 dmit.io 时，本脚本把响应里的
 * Set-Cookie 合并进 $persistentStore，并记录浏览器 UA，供面板脚本
 * DMIT-Traffic.js 直接调用 DMIT 接口。
 *
 * 存储键：
 *   dmit_cookie_jar  完整 Cookie（"a=b; c=d"）
 *   dmit_ua          浏览器 User-Agent（用于 Cloudflare 校验）
 */

const COOKIE_KEY = "dmit_cookie_jar";
const UA_KEY = "dmit_ua";

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

// 1) 记录浏览器 UA（用于面板请求时保持一致的指纹）
const ua = headerValue(typeof $request !== "undefined" ? $request.headers : null, "user-agent");
if (ua) {
  $persistentStore.write(String(ua), UA_KEY);
}

// 2) 捕获 Set-Cookie 并合并进 cookie jar
const responseHeaders =
  typeof $response !== "undefined" ? ($response.headers || []) : [];

let hasSetCookie = false;
if (Array.isArray(responseHeaders)) {
  for (let i = 0; i < responseHeaders.length; i++) {
    if (String(responseHeaders[i].field || "").toLowerCase() === "set-cookie") {
      hasSetCookie = true;
      break;
    }
  }
} else {
  for (const k in responseHeaders) {
    if (k.toLowerCase() === "set-cookie") {
      hasSetCookie = true;
      break;
    }
  }
}

if (hasSetCookie) {
  const jar = {};
  const raw = $persistentStore.read(COOKIE_KEY) || "";
  raw.split(";").forEach((p) => {
    const eq = p.indexOf("=");
    if (eq > 0) jar[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });

  const hdrs = Array.isArray(responseHeaders)
    ? responseHeaders
    : Object.keys(responseHeaders).map((k) => ({ field: k, value: responseHeaders[k] }));

  let changed = false;
  hdrs.forEach((h) => {
    if (String(h.field || "").toLowerCase() !== "set-cookie") return;
    const c = parseCookie(h.value);
    if (!c) return;
    if (c.value === "deleted" || c.value === "" || c.value === "expired") {
      delete jar[c.name];
    } else {
      jar[c.name] = c.value;
    }
    changed = true;
  });

  if (changed) {
    const s = Object.keys(jar)
      .map((k) => `${k}=${jar[k]}`)
      .join("; ");
    $persistentStore.write(s, COOKIE_KEY);
  }
}

$done({});
