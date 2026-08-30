/*
 * Surge 面板脚本：DMIT VPS 流量（Cookie 模式）
 *
 * 读取 MITM 自动捕获的 Cookie，直接调用 DMIT 面板接口，显示真实账单流量：
 * 已用/上限、百分比、剩余、距重置天数、入站/出站、限速/暂停/超量状态。
 *
 * 模块参数：
 *   SERVICE_ID  可选。有多个 VPS 时指定 WHMCS 服务 ID；留空取第一个 active
 *   COOKIE      可选。仅当无法开启 MITM 时手动粘贴完整 Cookie（否则留空）
 */

const API_URL =
  "https://www.dmit.io/modules/addons/dmit_kernel/get_products.php?page=1&per_page=100";
const COOKIE_KEY = "dmit_cookie_jar";
const UA_KEY = "dmit_ua";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseArguments(raw) {
  const result = {};
  String(raw || "")
    .split("&")
    .forEach((item) => {
      const idx = item.indexOf("=");
      if (idx < 0) return;
      const key = item.slice(0, idx).trim();
      const value = item.slice(idx + 1).trim();
      if (key) result[key] = value;
    });
  return result;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 100 || unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatQuota(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "不限量";
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1000) return `${(gib / 1000).toFixed(2)} TB`;
  const digits = gib >= 100 ? 0 : gib >= 10 ? 1 : 2;
  return `${gib.toFixed(digits)} GB`;
}

function daysUntilReset(resetDay) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(resetDay, daysInMonth);
  let reset = new Date(year, month, day);
  const todayMidnight = new Date(year, month, now.getDate());
  if (todayMidnight > reset) {
    const nextMonth = month + 1;
    const nextDaysInMonth = new Date(year, nextMonth + 1, 0).getDate();
    reset = new Date(year, nextMonth, Math.min(resetDay, nextDaysInMonth));
  }
  return Math.max(0, Math.ceil((reset.getTime() - now.getTime()) / 86400000));
}

function finish(title, content, style) {
  $done({ title: title, content: content, style: style });
}

const args = parseArguments(typeof $argument === "undefined" ? "" : $argument);
const serviceId = (args.SERVICE_ID || "").trim();
const manualCookie = (args.COOKIE || "").trim();

const cookie = manualCookie || ($persistentStore.read(COOKIE_KEY) || "").trim();
const ua = ($persistentStore.read(UA_KEY) || DEFAULT_UA).trim();

if (!cookie) {
  finish("DMIT VPS", "未捕获到 Cookie\n请先用浏览器登录 dmit.io（需开启 MITM）", "error");
} else {
  $httpClient.get(
    {
      url: API_URL,
      headers: {
        Cookie: cookie,
        "User-Agent": ua,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        Referer: "https://www.dmit.io/",
        Origin: "https://www.dmit.io",
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15,
      "auto-cookie": false,
    },
    (error, response, data) => {
      if (error) {
        finish("DMIT VPS", `查询失败：${error}`, "error");
        return;
      }
      if (!response || response.status !== 200) {
        finish("DMIT VPS", `DMIT 返回 HTTP ${response ? response.status : "未知"}`, "error");
        return;
      }

      const text = String(data || "");
      if (text.trim().startsWith("<") || text.toLowerCase().indexOf("<html") >= 0) {
        finish("DMIT VPS", "被 Cloudflare 拦截\n请重新登录 dmit.io 刷新 Cookie", "error");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        finish("DMIT VPS", "响应解析失败", "error");
        return;
      }
      if (!payload || payload.result !== "success") {
        finish("DMIT VPS", `DMIT 返回异常：${(payload && payload.result) || "未知"}`, "error");
        return;
      }

      const items = (payload.data && payload.data.items) || [];
      if (!items.length) {
        finish("DMIT VPS", "未获取到服务，Cookie 可能已失效", "error");
        return;
      }

      let item = null;
      if (serviceId) {
        item = items.find((it) => String(it.id) === String(serviceId));
      }
      if (!item) {
        item = items.find((it) => it.status === "active") || items[0];
      }

      const used = Math.round((Number(item.bw_usage) || 0) * 1048576);
      const limit = Math.round((Number(item.bw_limit) || 0) * 1048576);
      const rx = Math.round((Number(item.bw_usage_in) || 0) * 1048576);
      const tx = Math.round((Number(item.bw_usage_out) || 0) * 1048576);

      let resetDay = null;
      const nd = String(item.nextduedate || "");
      const parts = nd.split("-");
      if (parts.length >= 3) {
        const d = parseInt(parts[2], 10);
        if (d >= 1 && d <= 31) resetDay = d;
      }

      const state = item.traffic_state || "normal";
      let style = "good";
      let badge = "";
      if (state === "suspended") {
        style = "error";
        badge = " · 已暂停";
      } else if (state === "rate_limited") {
        style = "error";
        badge = " · 已限速";
      } else if (item.over_quota) {
        style = "error";
        badge = " · 已超量";
      }

      const name = item.productname || item.domain || "DMIT VPS";
      let title, content;

      if (limit > 0) {
        const remaining = Math.max(limit - used, 0);
        const pct = Math.min(Math.max((used / limit) * 100, 0), 100);
        if (style === "good") {
          style = pct >= 90 ? "error" : pct >= 75 ? "alert" : "good";
        }
        title = `${name} · ${pct.toFixed(1)}%${badge}`;
        content = [
          `已用：${formatBytes(used)} / ${formatQuota(limit)}`,
          `剩余：${formatBytes(remaining)}${resetDay ? ` · ${daysUntilReset(resetDay)} 天后重置` : ""}`,
          `↓ ${formatBytes(rx)}   ↑ ${formatBytes(tx)}`,
        ].join("\n");
      } else {
        title = `${name}${badge}`;
        content = [
          `已用：${formatBytes(used)} / 不限量`,
          resetDay ? `${daysUntilReset(resetDay)} 天后重置` : "",
          `↓ ${formatBytes(rx)}   ↑ ${formatBytes(tx)}`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      finish(title, content, style);
    }
  );
}
