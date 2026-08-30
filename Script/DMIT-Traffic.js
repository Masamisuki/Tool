/*
 * Surge 面板脚本：DMIT VPS 流量（Cookie 模式，支持多账号、多台 VPS）
 *
 * 读取 MITM 自动捕获的多个 cookie jar，逐个查询 DMIT 面板接口，合并所有
 * 账号的 VPS 流量（按服务 ID 去重），用进度条等美化排版展示。
 */

const API_URL =
  "https://www.dmit.io/modules/addons/dmit_kernel/get_products.php?page=1&per_page=100";
const JARS_KEY = "dmit_cookie_jars";
const COOKIE_KEY = "dmit_cookie_jar";
const UA_KEY = "dmit_ua";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 图标与配色：正常=DMIT 紫，告警=橙，异常=红
const ICON = "server.rack";
const COLOR_GOOD = "#7C4DFF";
const COLOR_ALERT = "#FF9500";
const COLOR_ERROR = "#FF3B30";

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

function resetDayOf(item) {
  const nd = String(item.nextduedate || "");
  const parts = nd.split("-");
  if (parts.length >= 3) {
    const d = parseInt(parts[2], 10);
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

// "YYYY-MM-DD" → "M月D日"
function formatDate(d) {
  const parts = String(d || "").split("-");
  if (parts.length >= 3) {
    const m = parseInt(parts[1], 10);
    const day = parseInt(parts[2], 10);
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) return `${m}月${day}日`;
  }
  return String(d || "");
}

// 当前时间 HH:MM:SS
function nowTime() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 重置文案：优先完整日期，其次倒计时
function resetTextOf(item) {
  const nd = String(item.nextduedate || "");
  if (nd && /^\d{4}-\d{2}-\d{2}/.test(nd)) return `${formatDate(nd)}重置`;
  const rd = resetDayOf(item);
  if (rd != null) return `${daysUntilReset(rd)} 天后重置`;
  return "";
}

function stateBadge(item) {
  const st = item.traffic_state || "normal";
  if (st === "suspended") return " · 已暂停";
  if (st === "rate_limited") return " · 已限速";
  if (item.over_quota) return " · 已超量";
  return "";
}

// 根据套餐名的地区前缀返回国旗 emoji
function flagFor(name) {
  const prefix = String(name || "").split(".")[0].toUpperCase();
  const map = {
    LAX: "🇺🇸",
    SJC: "🇺🇸",
    HKG: "🇭🇰",
    TYO: "🇯🇵",
    TOKYO: "🇯🇵",
  };
  return map[prefix] || "";
}

function finish(title, content, style) {
  const color =
    style === "error" ? COLOR_ERROR : style === "alert" ? COLOR_ALERT : COLOR_GOOD;
  $done({ title: title, content: content, icon: ICON, "icon-color": color });
}

function loadJars() {
  const raw = $persistentStore.read(JARS_KEY) || "";
  try {
    const a = JSON.parse(raw);
    if (Array.isArray(a) && a.length) return a;
  } catch (_) {}
  const old = ($persistentStore.read(COOKIE_KEY) || "").trim();
  if (old) return [{ s: "", c: old }];
  return [];
}

function buildOptions(cookie, ua) {
  return {
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
  };
}

function render(items) {
  if (!items.length) {
    finish("DMIT VPS", "查询失败\nCookie 可能已过期，请重新登录 dmit.io", "error");
    return;
  }

  // 汇总配色：暂停/限速/超量 = 红；任一 >=90% 红；任一 >=75% 橙；否则紫
  let style = "good";
  items.forEach((it) => {
    const st = it.traffic_state || "normal";
    if (st === "suspended" || st === "rate_limited" || it.over_quota) {
      style = "error";
    }
    const limit = Number(it.bw_limit) || 0;
    const used = Number(it.bw_usage) || 0;
    if (limit > 0 && style !== "error") {
      const pct = (used / limit) * 100;
      if (pct >= 90) style = "error";
      else if (pct >= 75) style = "alert";
    }
  });

  const blocks = items.map((it) => {
    const used = Math.round((Number(it.bw_usage) || 0) * 1048576);
    const limit = Math.round((Number(it.bw_limit) || 0) * 1048576);
    const rx = Math.round((Number(it.bw_usage_in) || 0) * 1048576);
    const tx = Math.round((Number(it.bw_usage_out) || 0) * 1048576);
    const rawName = it.productname || it.domain || "VPS";
    const flag = flagFor(it.productname || "");
    const name = flag ? `${flag} ${rawName}` : rawName;
    const resetText = resetTextOf(it);
    const badge = stateBadge(it);
    const io = `↓${formatBytes(rx).replace(" ", "")} ↑${formatBytes(tx).replace(" ", "")}`;

    if (limit > 0) {
      const pct = Math.min(Math.max((used / limit) * 100, 0), 100);
      const remaining = Math.max(limit - used, 0);
      return [
        `${name}  ${pct.toFixed(1)}%${badge}`,
        `已用 ${formatBytes(used)}/${formatQuota(limit)} · 剩余 ${formatBytes(remaining)}`,
        resetText ? `${io} · ${resetText}` : io,
      ].join("\n");
    } else {
      return [
        `${name}${badge}`,
        `已用 ${formatBytes(used)}/不限量`,
        resetText ? `${io} · ${resetText}` : io,
      ].join("\n");
    }
  });

  finish("DMIT VPS 流量", `${blocks.join("\n\n")}\n\n执行时间:${nowTime()}`, style);
}

const jars = loadJars();
const ua = ($persistentStore.read(UA_KEY) || DEFAULT_UA).trim();

if (!jars.length) {
  finish("DMIT VPS", "未捕获到 Cookie\n请先用浏览器登录 dmit.io（需开启 MITM）", "error");
} else {
  const allItems = [];
  const seen = {};
  let pending = jars.length;

  jars.forEach((jar) => {
    $httpClient.get(buildOptions(jar.c, ua), (error, response, data) => {
      pending -= 1;

      if (!error && response && response.status === 200) {
        const text = String(data || "");
        if (!(text.trim().startsWith("<") || text.toLowerCase().indexOf("<html") >= 0)) {
          let payload = null;
          try {
            payload = JSON.parse(text);
          } catch (_) {}
          if (payload && payload.result === "success") {
            const items = (payload.data && payload.data.items) || [];
            items.forEach((it) => {
              if (!it) return;
              if (it.id != null) {
                if (seen[it.id]) return;
                seen[it.id] = true;
              }
              allItems.push(it);
            });
          }
        }
      }

      if (pending === 0) {
        render(allItems);
      }
    });
  });
}
