// Prometheus 文本格式解析与格式化工具

export type MetricSample = {
  name: string
  labels: Record<string, string>
  value: number
}

function unescapeLabelValue(v: string): string {
  return v.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
}

export function parsePrometheus(text: string): MetricSample[] {
  const samples: MetricSample[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    let name = ""
    let labels: Record<string, string> = {}
    let rest = ""

    const brace = line.indexOf("{")
    if (brace >= 0) {
      name = line.slice(0, brace)
      const close = line.lastIndexOf("}")
      if (close < brace) continue
      const labelStr = line.slice(brace + 1, close)
      rest = line.slice(close + 1).trim()
      const re = /(\w+)="((?:[^"\\]|\\.)*)"/g
      let m: RegExpExecArray | null
      while ((m = re.exec(labelStr)) !== null) {
        labels[m[1]] = unescapeLabelValue(m[2])
      }
    } else {
      const space = line.indexOf(" ")
      if (space < 0) continue
      name = line.slice(0, space)
      rest = line.slice(space + 1).trim()
    }

    const value = parseFloat(rest)
    if (!Number.isNaN(value)) {
      samples.push({ name, labels, value })
    }
  }
  return samples
}

export function gaugeValue(samples: MetricSample[], name: string): number | null {
  const s = samples.find((s) => s.name === name)
  return s ? s.value : null
}

export function seriesByLabel(
  samples: MetricSample[],
  name: string,
  label: string
): { label: string; value: number }[] {
  return samples
    .filter((s) => s.name === name && label in s.labels)
    .map((s) => ({ label: s.labels[label], value: s.value }))
}

export function buildInfo(
  samples: MetricSample[]
): { version: string; build: string; system: string } | null {
  const s = samples.find((s) => s.name === "surge_build_info")
  if (!s) return null
  return {
    version: s.labels.version ?? "",
    build: s.labels.build ?? "",
    system: s.labels.system ?? "",
  }
}

// ---------- 格式化 ----------

export function formatBytes(bytes: number): string {
  const { value, unit } = formatBytesParts(bytes)
  return unit ? `${value} ${unit}` : value
}

export function formatBytesParts(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes)) return { value: "—", unit: "" }
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = Math.abs(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)
  return { value: `${bytes < 0 ? "-" : ""}${text}`, unit: units[i] }
}

export function formatSpeed(bytesPerSec: number): string {
  const { value, unit } = formatSpeedParts(bytesPerSec)
  return unit ? `${value} ${unit}` : value
}

export function formatSpeedParts(bytesPerSec: number): { value: string; unit: string } {
  const p = formatBytesParts(bytesPerSec)
  if (!p.unit) return p
  return { value: p.value, unit: `${p.unit}/s` }
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Surge HTTP API 的 epoch：请求 startDate 等为 Unix 秒；已是毫秒则原样返回 */
export function surgeTimestampToMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return NaN
  return ts < 1e12 ? ts * 1000 : ts
}

/** /v1/traffic.startTime → 引擎已运行秒数。epoch 秒/毫秒，或较短的时长值。 */
export function uptimeSecondsFromStartTime(startTime: number, now = Date.now()): number | null {
  if (!Number.isFinite(startTime) || startTime <= 0) return null
  if (startTime >= 1e12) return Math.max(0, (now - startTime) / 1000)
  if (startTime >= 1e9) return Math.max(0, (now - startTime * 1000) / 1000)
  if (startTime >= 1e7) return startTime / 1000
  return startTime
}

export function formatRequestDateTime(ts?: number | null): string {
  if (ts == null) return "—"
  const ms = surgeTimestampToMs(ts)
  if (!Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatRequestClock(ts?: number | null): string {
  if (ts == null) return ""
  const ms = surgeTimestampToMs(ts)
  if (!Number.isFinite(ms)) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return sameDay ? hms : `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatDelay(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—"
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

export type LatencyBenchmark = {
  lastTestErrorMessage?: string | null
  lastTestScoreInMS?: number
  testing?: number | boolean
}

export type LatencyStatus = "testing" | "fail" | "ms" | "none"

export function latencyForeground(ms: number): "systemGreen" | "systemOrange" | "systemRed" {
  return ms < 300 ? "systemGreen" : ms < 800 ? "systemOrange" : "systemRed"
}

function plausibleLatencyMs(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n < 60000
}

export function resolvePolicyLatency(args: {
  live?: number | null
  benchmark?: LatencyBenchmark | null
  testScore?: number | null
}): { status: LatencyStatus; ms?: number } {
  if (args.live === null) return { status: "fail" }
  if (typeof args.live === "number" && Number.isFinite(args.live)) {
    return args.live > 0 ? { status: "ms", ms: args.live } : { status: "fail" }
  }
  const bm = args.benchmark
  if (bm?.testing === 1 || bm?.testing === true) return { status: "testing" }
  if (typeof bm?.lastTestScoreInMS === "number" && bm.lastTestScoreInMS > 0) {
    return { status: "ms", ms: bm.lastTestScoreInMS }
  }
  if (bm && bm.lastTestScoreInMS === 0 && bm.lastTestErrorMessage) return { status: "fail" }
  if (typeof args.testScore === "number" && plausibleLatencyMs(args.testScore)) {
    return { status: "ms", ms: args.testScore }
  }
  return { status: "none" }
}

export function pickBenchmark(
  map: Record<string, LatencyBenchmark> | null | undefined,
  option: { lineHash?: string; name: string }
): LatencyBenchmark | undefined {
  if (!map) return undefined
  if (option.lineHash && map[option.lineHash]) return map[option.lineHash]
  if (map[option.name]) return map[option.name]
  return undefined
}

export function testResultScore(results: unknown, groupName: string, policyName: string): number | undefined {
  if (!results || typeof results !== "object") return undefined
  const cur = (results as Record<string, unknown>)[groupName]
  if (!Array.isArray(cur)) return undefined
  for (const v of cur) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const rec = v as Record<string, unknown>
    const name = String(rec.policy ?? rec.name ?? "")
    if (name !== policyName) continue
    for (const key of ["score", "available-total", "tcp", "receive"]) {
      const n = Number(rec[key])
      if (plausibleLatencyMs(n)) return n
    }
  }
  return undefined
}

/** 解析 Surge 事件的日期字符串（如 "2026-08-13T14:00:00+0800"） */
export function parseSurgeDate(s: string): Date | null {
  const normalized = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatEventTime(s: string): string {
  const d = parseSurgeDate(s)
  if (!d) return s
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const p = (n: number) => String(n).padStart(2, "0")
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

/** 策略名是否为直连（含 DIRECT / 直连） */
export function isDirectPolicy(name: string): boolean {
  return /(^|[\s/])DIRECT(?:$|[-_\s/])|^DIRECT$|直连/i.test(name.trim())
}

export function isRejectPolicy(name: string | undefined | null): boolean {
  return /REJECT/i.test(name ?? "")
}

/** 系统网卡名的可读说明；无法识别则返回 null */
export function ifaceDisplayName(name: string): string | null {
  if (name === "lo0" || name === "lo") return "回环"
  if (/^pdp_ip/i.test(name)) return "蜂窝"
  if (/^en\d+$/i.test(name)) return "Wi-Fi"
  if (/^utun/i.test(name)) return "隧道"
  if (/^awdl/i.test(name)) return "隔空投送"
  return null
}

/** Surge Fake-IP：198.18.0.0/15 与 fd00:6152::/32 */
export function isFakeIp(addr: string): boolean {
  const s = addr.trim().toLowerCase()
  if (/^198\.(18|19)(?:\.\d{1,3}){2}$/.test(s)) return true
  if (s === "fd00:6152::" || s.startsWith("fd00:6152:") || s.startsWith("fd00:6152::")) return true
  return false
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

function isIpv6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(":") || s.includes(":::")) return false
  const doubles = s.split("::").length - 1
  if (doubles > 1) return false
  const groups = s.split(":").filter((g) => g.length > 0)
  const tail = groups[groups.length - 1] ?? ""
  const embedsV4 = tail.includes(".")
  if (embedsV4 && !IPV4_RE.test(tail)) return false
  const hexGroups = embedsV4 ? groups.slice(0, -1) : groups
  if (hexGroups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false
  const width = hexGroups.length + (embedsV4 ? 2 : 0)
  return doubles === 1 ? width < 8 : width === 8
}

export function isIpAddress(s: string): boolean {
  const t = s.trim()
  return IPV4_RE.test(t) || isIpv6(t)
}

/** 从 "1.2.3.4:443"、"[2001:db8::1]:443"、"1.2.3.4 (Proxy)" 等写法里取出 IP */
export function extractIpAddress(raw: string | undefined | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (isIpAddress(s)) return s
  const bracket = /^\[([0-9a-f:.]+)\](?::\d+)?/i.exec(s)
  if (bracket && isIpv6(bracket[1])) return bracket[1]
  const token = s.split(/[\s(（,]/)[0] ?? ""
  if (isIpAddress(token)) return token
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(token)
  if (v4Port && IPV4_RE.test(v4Port[1])) return v4Port[1]
  return null
}

/** 私有、回环、链路本地、CGNAT、组播与 Fake-IP 查不到归属，不值得发请求 */
export function isPublicIp(ip: string): boolean {
  const s = ip.trim().toLowerCase()
  if (isFakeIp(s)) return false
  if (IPV4_RE.test(s)) {
    const [a, b] = s.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    return true
  }
  if (!isIpv6(s)) return false
  if (s === "::" || s === "::1") return false
  if (/^fe[89ab]/.test(s) || /^f[cd]/.test(s) || s.startsWith("ff")) return false
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (mapped) return isPublicIp(mapped[1])
  return true
}

/** ISO 3166 两位代码 → 旗帜 emoji */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[a-z]{2}$/i.test(code)) return ""
  const base = 0x1f1e6
  return String.fromCodePoint(...code.toUpperCase().split("").map((ch) => base + ch.charCodeAt(0) - 65))
}

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null
  try {
    const names = new Intl.DisplayNames(["zh-Hans"], { type: "region" })
    const n = names.of(code.toUpperCase())
    return n && n !== code.toUpperCase() ? n : code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

/** GeoIP 结果的一行摘要：「🇦🇺 澳大利亚 · AS13335 Cloudflare, Inc.」；全空返回 null */
export function formatGeoSummary(g: {
  country?: string | null
  asn?: number | null
  organization?: string | null
} | null | undefined): string | null {
  if (!g) return null
  const parts: string[] = []
  if (g.country) parts.push(`${countryFlag(g.country)} ${countryName(g.country)}`.trim())
  const as = [g.asn != null ? `AS${g.asn}` : "", g.organization ?? ""].filter((x) => x).join(" ")
  if (as) parts.push(as)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Unix 秒（或毫秒）→「3 分钟前」；0 / 缺失返回 null */
export function formatAge(ts: number | null | undefined, now = Date.now()): string | null {
  if (ts == null) return null
  const ms = surgeTimestampToMs(ts)
  if (!Number.isFinite(ms)) return null
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 60) return "刚刚"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

export function formatDate(ts: number | null | undefined): string | null {
  if (ts == null) return null
  const ms = surgeTimestampToMs(ts)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export type ResourceStatus = "updating" | "error" | "never" | "local" | "ready" | "pending"

/** 外部资源列表行状态：更新中 > 出错 > 从未下载 > 本地 > 就绪 */
export function resourceStatus(r: {
  local: boolean
  ready: boolean
  updatedAt?: number
  updating?: boolean
  error?: string
}): ResourceStatus {
  if (r.updating) return "updating"
  if (r.error) return "error"
  if (r.local) return r.ready ? "local" : "error"
  if (!r.updatedAt) return r.ready ? "ready" : "never"
  return r.ready ? "ready" : "pending"
}

/** 资源路径的短名：URL 取末段文件名并去掉查询串，本地路径取文件名 */
export function resourceDisplayName(path: string): string {
  const s = path.trim()
  const noQuery = s.split(/[?#]/)[0] ?? s
  const segs = noQuery.split("/").filter((x) => x.length > 0)
  const last = segs[segs.length - 1] ?? s
  if (/^[a-z][a-z0-9+.-]*:$/i.test(last) || segs.length <= 1) return s
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export function resourceHost(path: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(path.trim())
  return m ? m[1] : null
}

export function collectRecordAddresses(entries: { data?: unknown }[] | undefined | null): string[] {
  if (!Array.isArray(entries)) return []
  const out: string[] = []
  for (const e of entries) {
    const d = e.data
    if (Array.isArray(d)) {
      for (const x of d) if (x != null && String(x).length > 0) out.push(String(x))
    } else if (typeof d === "string" && d.length > 0) {
      out.push(d)
    }
  }
  return out
}

export function countFakeIps(addrs: string[]): number {
  const seen = new Set<string>()
  for (const a of addrs) {
    const t = a.trim()
    if (isFakeIp(t)) seen.add(t.toLowerCase())
  }
  return seen.size
}

/** 截图分享时遮住地址，不保留网段信息 */
export function maskIp(addr: string): string {
  const s = addr.trim()
  if (!s) return s
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return "•.•.•.•"
  if (s.includes(":")) return "•:•:•:•"
  return "•••"
}

export function maskHost(host: string): string {
  const s = host.trim()
  if (!s) return s
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || s.includes(":")) return maskIp(s)
  return "•••"
}

export function displayHostPort(host: string, port: string, hidden: boolean): string {
  const raw = hidden ? maskHost(host) : host.trim().replace(/^\[|\]$/g, "")
  const h = raw.includes(":") ? `[${raw}]` : raw
  const p = port.trim()
  return p ? `${h}:${p}` : h
}

export function displayPrimaryAddrs(addrs: { ipv4?: string; ipv6?: string }, hidden: boolean): string {
  return [addrs.ipv4, addrs.ipv6]
    .filter((x): x is string => Boolean(x))
    .map((a) => (hidden ? maskIp(a) : a))
    .join(" / ")
}

export function parsePrimaryAddresses(raw: unknown): { ipv4?: string; ipv6?: string } {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== "object") return {}
  const o = value as Record<string, unknown>
  const inner = o.result ?? o.output ?? o.value ?? o.data ?? o
  const rec = inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : o
  const v4 = rec.v4 && typeof rec.v4 === "object" ? (rec.v4 as Record<string, unknown>) : null
  const v6 = rec.v6 && typeof rec.v6 === "object" ? (rec.v6 as Record<string, unknown>) : null
  const ipv4 = typeof v4?.primaryAddress === "string" && v4.primaryAddress ? v4.primaryAddress : undefined
  const ipv6 = typeof v6?.primaryAddress === "string" && v6.primaryAddress ? v6.primaryAddress : undefined
  return { ipv4, ipv6 }
}

/** /v1/scripting/evaluate 执行 `$done($environment)` 的返回 → Surge 版本 / 构建号 */
/** evaluate 的返回外层包装未文档化：逐层解开 JSON 字符串与 result / output / value / data，直到对象含指定键 */
function unwrapScriptResult(raw: unknown, keys: string[], depth = 0): Record<string, unknown> | null {
  if (depth > 3 || raw == null) return null
  if (typeof raw === "string") {
    try {
      return unwrapScriptResult(JSON.parse(raw), keys, depth + 1)
    } catch {
      return null
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (keys.some((k) => k in o)) return o
  for (const k of ["result", "output", "value", "data"]) {
    const inner = unwrapScriptResult(o[k], keys, depth + 1)
    if (inner) return inner
  }
  return null
}

export function parseEngineInfo(raw: unknown): { version?: string; build?: string; system?: string } {
  const env = unwrapScriptResult(raw, ["surge-version", "surge-build"])
  if (!env) return {}
  const str = (v: unknown) => (v == null || v === "" ? undefined : String(v))
  return { version: str(env["surge-version"]), build: str(env["surge-build"]), system: str(env.system) }
}

export type ExternalPolicy = { name: string; group: string; identifier: string }

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v) return v
    if (typeof v === "number") return String(v)
  }
  return undefined
}

function toExternalPolicy(raw: unknown, groupHint?: string): ExternalPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const name = firstString(o, ["name", "policy", "policyName", "policy_name", "policy-name"])
  const group = firstString(o, ["group", "groupName", "group_name", "group-name", "policyGroup", "policy-group"]) ?? groupHint
  const identifier = firstString(o, ["identifier", "id", "key", "lineHash", "line-hash"])
  return name && group && identifier ? { name, group, identifier } : null
}

/**
 * GET /v1/policies?include_external=true 的 external-policies（字段名尚无文档，宽松解析）。
 * 字段缺失（旧版 Surge 忽略该参数）返回 null；兼容数组与「组名 → 数组」两种形状。
 */
export function parseExternalPolicies(body: unknown): ExternalPolicy[] | null {
  if (!body || typeof body !== "object") return null
  const o = body as Record<string, unknown>
  const raw = o["external-policies"] ?? o.externalPolicies ?? o.external_policies
  if (raw == null) return null
  const out: ExternalPolicy[] = []
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const p = toExternalPolicy(e)
      if (p) out.push(p)
    }
  } else if (typeof raw === "object") {
    for (const [group, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      for (const e of list) {
        const p = toExternalPolicy(e, group)
        if (p) out.push(p)
      }
    }
  }
  return out
}

/** 通过 $httpClient 的 policy 选项（外部策略只能用 identifier 引用）并发测量请求耗时 */
export function buildPolicyLatencyScript(identifiers: string[], url: string, timeoutSec: number): string {
  return [
    `const ids = ${JSON.stringify(identifiers)};`,
    `const url = ${JSON.stringify(url)};`,
    "const results = {};",
    "let left = ids.length;",
    "if (left === 0) $done({ results });",
    "ids.forEach((id) => {",
    "  const t0 = Date.now();",
    `  $httpClient.get({ url, policy: id, timeout: ${Math.max(1, Math.round(timeoutSec))} }, (error, response) => {`,
    "    results[id] = error || !response ? null : Math.max(1, Date.now() - t0);",
    "    left -= 1;",
    "    if (left === 0) $done({ results });",
    "  });",
    "});",
  ].join("\n")
}

/** buildPolicyLatencyScript 的 evaluate 返回 → identifier → 毫秒（失败为 null） */
export function parsePolicyLatencyResults(raw: unknown): Record<string, number | null> | null {
  const o = unwrapScriptResult(raw, ["results"])
  const r = o?.results
  if (!r || typeof r !== "object" || Array.isArray(r)) return null
  const out: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    out[k] = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
  }
  return out
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)))
  return out
}

export type MemoryPoint = { t: number; mem: number }

const RECENT_MEM_MS = 20 * 60 * 1000

/** 对 mem(MB) ~ 时间(分钟) 做最小二乘斜率 */
export function memorySlopeMBPerMin(pts: MemoryPoint[]): number {
  if (pts.length < 2) return 0
  const t0 = pts[0].t
  const n = pts.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const p of pts) {
    const x = (p.t - t0) / 60000
    const y = p.mem / (1024 * 1024)
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denom = n * sumXX - sumX * sumX
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return 0
  const slope = (n * sumXY - sumX * sumY) / denom
  return Number.isFinite(slope) ? slope : 0
}

export function formatMemSlope(mbPerMin: number): string {
  const abs = Math.abs(mbPerMin)
  if (!Number.isFinite(mbPerMin) || abs < 0.005) return "≈ 0"
  const sign = mbPerMin > 0 ? "+" : ""
  if (abs < 1) return `${sign}${mbPerMin.toFixed(2)} MB/分`
  return `${sign}${mbPerMin.toFixed(1)} MB/分`
}

export type MemRangeMin = 2 | 60 | 360 | 720 | 1440

export const MEM_RANGE_OPTIONS: { tag: string; minutes: MemRangeMin; label: string }[] = [
  { tag: "2", minutes: 2, label: "2 分钟" },
  { tag: "60", minutes: 60, label: "1 小时" },
  { tag: "360", minutes: 360, label: "6 小时" },
  { tag: "720", minutes: 720, label: "12 小时" },
  { tag: "1440", minutes: 1440, label: "24 小时" },
]

export function downsampleToMinute(pts: MemoryPoint[]): MemoryPoint[] {
  const out: MemoryPoint[] = []
  for (const p of pts) {
    if (!(p.mem > 0)) continue
    const last = out[out.length - 1]
    if (!last || p.t - last.t >= 50_000) out.push({ t: p.t, mem: p.mem })
    else last.mem = p.mem
  }
  return out
}

export function appendMinuteSample(
  series: MemoryPoint[],
  point: MemoryPoint,
  retainMs = 25 * 60 * 60 * 1000
): MemoryPoint[] {
  const next = downsampleToMinute([...series, point])
  const cut = point.t - retainMs
  return next.filter((p) => p.t >= cut)
}

export function historyForRange(
  highRes: MemoryPoint[],
  longMem: MemoryPoint[],
  rangeMs: number,
  now = Date.now()
): MemoryPoint[] {
  const cut = now - rangeMs
  const recent = highRes.filter((p) => p.t >= cut && p.mem > 0)
  if (rangeMs <= 2.5 * 60 * 1000) return recent
  const t0 = recent[0]?.t ?? now + 1
  const older = longMem.filter((p) => p.t >= cut && p.t < t0 && p.mem > 0)
  return [...older, ...recent]
}

export function analyzeMemoryTrend(
  history: MemoryPoint[],
  opts?: { recentMs?: number; intervalSec?: number }
): {
  level: "ok" | "warning" | "insufficient"
  message: string
  peakMB: number
  minMB: number
  currentMB: number
  rangeMB: number
  slopeMBPerMin: number
  windowMin: number
  historyMin: number
  samples: number
} {
  const empty = {
    peakMB: 0,
    minMB: 0,
    currentMB: 0,
    rangeMB: 0,
    slopeMBPerMin: 0,
    windowMin: 0,
    historyMin: 0,
    samples: 0,
  }
  const pts = history.filter((p) => p.mem > 0)
  if (pts.length < 12) {
    // 判定门槛是 12 个采样点，需要的时长随刷新间隔变化
    const needMin = Math.max(1, Math.ceil((12 * (opts?.intervalSec ?? 5)) / 60))
    return {
      level: "insufficient",
      message: `采样数据不足，持续运行约 ${needMin} 分钟后再查看趋势判断。`,
      ...empty,
      samples: pts.length,
      currentMB: pts.length ? pts[pts.length - 1].mem / (1024 * 1024) : 0,
      historyMin: pts.length >= 2 ? (pts[pts.length - 1].t - pts[0].t) / 60000 : 0,
    }
  }
  const lastT = pts[pts.length - 1].t
  const recentMs = opts?.recentMs ?? RECENT_MEM_MS
  let recent = pts.filter((p) => lastT - p.t <= recentMs)
  if (recent.length < 12) recent = pts.slice(-Math.min(pts.length, 24))
  const mems = pts.map((p) => p.mem)
  const peakMB = Math.max(...mems) / (1024 * 1024)
  const minMB = Math.min(...mems) / (1024 * 1024)
  const currentMB = mems[mems.length - 1] / (1024 * 1024)
  const rangeMB = Math.max(0, peakMB - minMB)
  const slopeMBPerMin = memorySlopeMBPerMin(recent)
  const windowMin = recent.length >= 2 ? (recent[recent.length - 1].t - recent[0].t) / 60000 : 0
  const historyMin = (pts[pts.length - 1].t - pts[0].t) / 60000
  let rising = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].mem >= recent[i - 1].mem) rising++
  }
  const risingRatio = recent.length > 1 ? rising / (recent.length - 1) : 0
  const stats = {
    peakMB,
    minMB,
    currentMB,
    rangeMB,
    slopeMBPerMin,
    windowMin,
    historyMin,
    samples: pts.length,
  }
  if (slopeMBPerMin > 0.5 && risingRatio > 0.85) {
    return {
      level: "warning",
      message: `近 ${Math.max(1, Math.round(windowMin))} 分钟内存持续上涨且不回落（约 ${formatMemSlope(slopeMBPerMin)}），可能存在泄漏。可尝试重新加载配置，或到「请求 → 事件」查看脚本报错。`,
      ...stats,
    }
  }
  return {
    level: "ok",
    message: `近 ${Math.max(1, Math.round(windowMin))} 分钟变化 ${formatMemSlope(slopeMBPerMin)}；所选范围振幅 ${rangeMB.toFixed(1)} MB，属正常波动。`,
    ...stats,
  }
}

/** 图表降采样到最多 n 个点（保留末点） */
export function downsample<T>(pts: T[], n: number): T[] {
  if (pts.length <= n) return pts
  const step = pts.length / n
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * step)])
  out.push(pts[pts.length - 1])
  return out
}
