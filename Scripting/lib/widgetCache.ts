// 小组件数据桥：面板运行时把精简后的状态写入 Storage，widget.tsx 只读缓存渲染。
// 注意：这里不引入 lib/ui.ts（它模块加载即读 Device.systemVersion），以保证小组件扩展内可安全加载。
import { Widget } from "scripting"
import { buildInfo, displayHostPort, formatBuildLabel, gaugeValue, type MetricSample } from "./metrics"
import type { TrafficSnapshot } from "./surgeApi"

export const WIDGET_CACHE_KEY = "surge_panel_widget_cache_v1"
export const WIDGET_SETTINGS_KEY = "surge_panel_widget_settings_v1"

/** 状态每秒都在变，写盘节流，避免频繁序列化 */
const CACHE_WRITE_INTERVAL_MS = 5000
/** 主动刷新桌面小组件的节流：WidgetKit 预算有限，面板常驻时不必每分钟刷一次 */
const WIDGET_RELOAD_INTERVAL_MS = 5 * 60_000
/** 刷新失败后的重试间隔（原来是单向闩锁，一次失败就永久不刷） */
const WIDGET_RELOAD_RETRY_MS = 10 * 60_000
/** 迷你速率曲线保留的采样点数 */
const CURVE_POINTS = 24

// ---------- 设置 ----------

export type WidgetSettings = {
  showMemory: boolean
  showUptime: boolean
  showRequests: boolean
  showDns: boolean
  showInterfaces: boolean
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  showMemory: true,
  showUptime: true,
  showRequests: true,
  showDns: true,
  showInterfaces: true,
}

export function loadWidgetSettings(): WidgetSettings {
  const saved = (Storage.get(WIDGET_SETTINGS_KEY) as Partial<WidgetSettings> | null) ?? {}
  return {
    showMemory: saved.showMemory !== false,
    showUptime: saved.showUptime !== false,
    showRequests: saved.showRequests !== false,
    showDns: saved.showDns !== false,
    showInterfaces: saved.showInterfaces !== false,
  }
}

export function saveWidgetSettings(next: WidgetSettings) {
  const safe: WidgetSettings = {
    showMemory: next.showMemory !== false,
    showUptime: next.showUptime !== false,
    showRequests: next.showRequests !== false,
    showDns: next.showDns !== false,
    showInterfaces: next.showInterfaces !== false,
  }
  Storage.set(WIDGET_SETTINGS_KEY, safe)
  return safe
}

// ---------- 快照 ----------

/** 单张网卡的累计流量；totalBytes 用于排序与比例条 */
export type WidgetIface = {
  name: string
  inBytes: number
  outBytes: number
  totalBytes: number
}

export type WidgetSnapshot = {
  v: number
  /** 写入时间 */
  ts: number
  /** 最近一次成功取数时间，0 表示还没有 */
  dataAt: number
  instance: string
  endpoint: string
  connected: boolean
  running: boolean
  error: string
  inSpeed: number
  outSpeed: number
  peakIn: number
  peakOut: number
  /** 以下 -1 表示该指标不可用 */
  memory: number
  uptime: number
  activeRequests: number
  dnsCache: number
  bans: number
  failed: number
  rejected: number
  totalIn: number
  totalOut: number
  /** 流量统计起始时间（毫秒），0 表示未知 */
  since: number
  /** 引擎版本标签，形如 Surge 5.102.0 • Build 3813；空字符串表示未知 */
  build: string
  /** 最近的下行 / 上行速率序列（字节每秒） */
  down: number[]
  up: number[]
  /** down/up 每点的采样时间戳（毫秒），与数组一一对应；用于区分采样间隔 */
  curveAt: number[]
  /** 各网卡累计流量，按 totalBytes 降序，最多 4 条 */
  ifaces: WidgetIface[]
}

export const EMPTY_WIDGET_SNAPSHOT: WidgetSnapshot = {
  v: 1,
  ts: 0,
  dataAt: 0,
  instance: "",
  endpoint: "",
  connected: false,
  running: false,
  error: "",
  inSpeed: 0,
  outSpeed: 0,
  peakIn: 0,
  peakOut: 0,
  memory: -1,
  uptime: -1,
  activeRequests: -1,
  dnsCache: -1,
  bans: -1,
  failed: 0,
  rejected: 0,
  totalIn: 0,
  totalOut: 0,
  since: 0,
  build: "",
  down: [],
  up: [],
  curveAt: [],
  ifaces: [],
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function numbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => num(x)).slice(-CURVE_POINTS)
}

function ifacesOf(raw: unknown): WidgetIface[] {
  if (!Array.isArray(raw)) return []
  const out: WidgetIface[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Partial<WidgetIface>
    const name = String(row.name ?? "").trim()
    if (!name) continue
    const inBytes = Math.max(0, num(row.inBytes))
    const outBytes = Math.max(0, num(row.outBytes))
    const totalBytes = row.totalBytes == null ? inBytes + outBytes : Math.max(0, num(row.totalBytes))
    out.push({ name, inBytes, outBytes, totalBytes })
  }
  return out.slice(0, 4)
}

export function loadWidgetSnapshot(): WidgetSnapshot {
  const raw = (Storage.get(WIDGET_CACHE_KEY) as Partial<WidgetSnapshot> | null) ?? {}
  const d = EMPTY_WIDGET_SNAPSHOT
  return {
    v: 1,
    ts: num(raw.ts),
    dataAt: num(raw.dataAt),
    instance: String(raw.instance ?? d.instance),
    endpoint: String(raw.endpoint ?? ""),
    connected: raw.connected === true,
    running: raw.running === true,
    error: String(raw.error ?? ""),
    inSpeed: num(raw.inSpeed),
    outSpeed: num(raw.outSpeed),
    peakIn: num(raw.peakIn),
    peakOut: num(raw.peakOut),
    memory: typeof raw.memory === "number" ? raw.memory : -1,
    uptime: typeof raw.uptime === "number" ? raw.uptime : -1,
    activeRequests: typeof raw.activeRequests === "number" ? raw.activeRequests : -1,
    dnsCache: typeof raw.dnsCache === "number" ? raw.dnsCache : -1,
    bans: typeof raw.bans === "number" ? raw.bans : -1,
    failed: num(raw.failed),
    rejected: num(raw.rejected),
    totalIn: num(raw.totalIn),
    totalOut: num(raw.totalOut),
    since: num(raw.since),
    build: String(raw.build ?? ""),
    down: numbers(raw.down),
    up: numbers(raw.up),
    curveAt: numbers(raw.curveAt),
    ifaces: ifacesOf(raw.ifaces),
  }
}

/** 面板 StoreState 的结构化子集，避免 store 与本文件循环依赖 */
export type WidgetSourceState = {
  instances: { id: string; name: string }[]
  activeId: string
  config: { host: string; port: string }
  prefs: { hideAddresses: boolean }
  samples: MetricSample[] | null
  traffic: TrafficSnapshot | null
  speeds: { inSpeed: number; outSpeed: number }
  peakSpeeds: { inSpeed: number; outSpeed: number }
  speedHistory: { t?: number; inSpeed: number; outSpeed: number }[]
  running: boolean
  error: string | null
  updatedAt: number | null
  failedRecent: number
  rejectedRecent: number
  /** 面板从 Surge 响应头拿到的版本标签，优先于指标里的 build_info */
  build?: string
}

function totalsOf(traffic: TrafficSnapshot | null): { totalIn: number; totalOut: number; since: number } {
  if (!traffic) return { totalIn: 0, totalOut: 0, since: 0 }
  const iface = traffic.interface ?? {}
  const table = Object.keys(iface).length > 0 ? iface : traffic.connector ?? {}
  let totalIn = 0
  let totalOut = 0
  for (const key of Object.keys(table)) {
    const entry = table[key]
    if (!entry) continue
    totalIn += num(entry.in)
    totalOut += num(entry.out)
  }
  const start = num(traffic.startTime)
  return { totalIn, totalOut, since: start > 1e12 ? start : start * 1000 }
}

function curveOf(history: { t?: number; inSpeed: number; outSpeed: number }[]): {
  down: number[]
  up: number[]
  at: number[]
} {
  const tail = Array.isArray(history) ? history.slice(-CURVE_POINTS) : []
  return {
    down: tail.map((p) => num(p?.inSpeed)),
    up: tail.map((p) => num(p?.outSpeed)),
    at: tail.map((p) => num(p?.t)),
  }
}

/** 与 totalsOf 同源：逐网卡拆出累计字节，按总量降序 */
function ifaceListOf(traffic: TrafficSnapshot | null): WidgetIface[] {
  if (!traffic) return []
  const iface = traffic.interface ?? {}
  const table = Object.keys(iface).length > 0 ? iface : traffic.connector ?? {}
  const rows: WidgetIface[] = []
  for (const key of Object.keys(table)) {
    const entry = table[key]
    if (!entry) continue
    const name = String(key).trim()
    if (!name) continue
    const inBytes = Math.max(0, num(entry.in))
    const outBytes = Math.max(0, num(entry.out))
    rows.push({ name, inBytes, outBytes, totalBytes: inBytes + outBytes })
  }
  rows.sort((a, b) => b.totalBytes - a.totalBytes)
  return rows.slice(0, 4)
}

/** 面板已经拼好的版本标签优先，否则从 surge_build_info 拼「Surge 5.102.0 • Build 3813」 */
function buildLabelOf(preferred: string, samples: MetricSample[] | null): string {
  const own = String(preferred ?? "").trim()
  if (own) return own
  try {
    const info = samples && samples.length > 0 ? buildInfo(samples) : null
    const label = formatBuildLabel(info?.version, info?.build)
    if (label) return label
  } catch {}
  return ""
}

export function buildWidgetSnapshot(src: WidgetSourceState): WidgetSnapshot {
  const samples = src.samples ?? []
  const gauge = (name: string): number => {
    const v = gaugeValue(samples, name)
    return v != null && Number.isFinite(v) ? v : -1
  }
  const active = src.activeId ? src.instances.find((i) => i.id === src.activeId) : undefined
  const totals = totalsOf(src.traffic)
  const curve = curveOf(src.speedHistory)
  const error = src.error ? String(src.error) : ""
  return {
    v: 1,
    ts: Date.now(),
    dataAt: num(src.updatedAt),
    instance: (active?.name ?? "").trim() || (src.activeId ? "Surge" : "未选择实例"),
    endpoint: displayHostPort(src.config?.host ?? "", src.config?.port ?? "", src.prefs?.hideAddresses === true),
    connected: !!src.updatedAt && !error,
    running: src.running === true,
    error,
    inSpeed: num(src.speeds?.inSpeed),
    outSpeed: num(src.speeds?.outSpeed),
    peakIn: num(src.peakSpeeds?.inSpeed),
    peakOut: num(src.peakSpeeds?.outSpeed),
    memory: gauge("surge_memory_bytes"),
    uptime: gauge("surge_uptime_seconds"),
    activeRequests: gauge("surge_active_requests"),
    dnsCache: gauge("surge_dns_cache_entries"),
    bans: gauge("surge_active_bans"),
    failed: num(src.failedRecent),
    rejected: num(src.rejectedRecent),
    totalIn: totals.totalIn,
    totalOut: totals.totalOut,
    since: totals.since,
    build: buildLabelOf(src.build ?? "", src.samples ?? null),
    down: curve.down,
    up: curve.up,
    curveAt: curve.at,
    ifaces: ifaceListOf(src.traffic),
  }
}

// ---------- 写出 ----------

let lastWriteAt = 0
let lastConnected: boolean | null = null
let lastReloadAt = 0
// 上次刷新的失败截止时间（到点自动重试，不再永久停用）
let reloadRetryAt = 0
let lastSnapshot: WidgetSnapshot | null = null

/** 上一份快照：模块内缓存，首次用时从 Storage 读一次 */
function previousSnapshot(): WidgetSnapshot {
  if (!lastSnapshot) {
    try {
      lastSnapshot = loadWidgetSnapshot()
    } catch {
      lastSnapshot = EMPTY_WIDGET_SNAPSHOT
    }
  }
  return lastSnapshot
}

/**
 * 沿用上一轮的指标：某一轮没拿到 gauge（例如商店版没有 /metrics）时不该让小组件突然掉成「--」。
 * 只有「本轮缺失且上轮有值」才沿用，真实变成 0 仍然会显示 0。
 */
export function carryGauges(next: WidgetSnapshot, prev: WidgetSnapshot | null): WidgetSnapshot {
  if (!prev) return next
  const keep = (value: number, before: number): number => (value < 0 && before >= 0 ? before : value)
  const out: WidgetSnapshot = {
    ...next,
    memory: keep(next.memory, prev.memory),
    uptime: keep(next.uptime, prev.uptime),
    activeRequests: keep(next.activeRequests, prev.activeRequests),
    dnsCache: keep(next.dnsCache, prev.dnsCache),
    bans: keep(next.bans, prev.bans),
  }
  // 速率为空时也别把曲线抹成空数组，保留上一轮的点
  if (out.down.length === 0 && prev.down.length > 0) {
    out.down = prev.down
    out.up = prev.up
    out.curveAt = prev.curveAt
  }
  return out
}

/** 面板状态变化时调用；默认节流 5s，连接状态变化或 force 时立即写入 */
export function publishWidgetSnapshot(src: WidgetSourceState, force = false) {
  let snap: WidgetSnapshot
  try {
    snap = carryGauges(buildWidgetSnapshot(src), previousSnapshot())
  } catch {
    return
  }
  const now = Date.now()
  // 首次写入不算「状态翻转」，否则每次冷启动都会白刷一次桌面小组件
  const flipped = lastConnected !== null && snap.connected !== lastConnected
  if (!force && !flipped && now - lastWriteAt < CACHE_WRITE_INTERVAL_MS) return
  try {
    Storage.set(WIDGET_CACHE_KEY, snap)
    lastSnapshot = snap
    lastWriteAt = now
    lastConnected = snap.connected
  } catch {
    return
  }
  reloadWidgetsThrottled(force || flipped)
}

/** 刷新桌面小组件；节流 5 分钟，失败后 10 分钟再试 */
export function reloadWidgetsThrottled(force = false) {
  const now = Date.now()
  if (now < reloadRetryAt) return
  if (!force && now - lastReloadAt < WIDGET_RELOAD_INTERVAL_MS) return
  lastReloadAt = now
  try {
    Widget.reloadUserWidgets()
  } catch {
    reloadRetryAt = now + WIDGET_RELOAD_RETRY_MS
  }
}
