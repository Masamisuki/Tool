// 小组件数据桥：面板运行时把精简后的状态写入 Storage，widget.tsx 只读缓存渲染。
// 注意：这里不引入 lib/ui.ts（它模块加载即读 Device.systemVersion），以保证小组件扩展内可安全加载。
import { Widget } from "scripting"
import { buildInfo, displayHostPort, gaugeValue, type MetricSample } from "./metrics"
import type { TrafficSnapshot } from "./surgeApi"

export const WIDGET_CACHE_KEY = "surge_panel_widget_cache_v1"
export const WIDGET_SETTINGS_KEY = "surge_panel_widget_settings_v1"

/** 状态每秒都在变，写盘节流，避免频繁序列化 */
const CACHE_WRITE_INTERVAL_MS = 5000
/** 主动刷新桌面小组件的节流 */
const WIDGET_RELOAD_INTERVAL_MS = 60_000
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
  speedHistory: { inSpeed: number; outSpeed: number }[]
  running: boolean
  error: string | null
  updatedAt: number | null
  failedRecent: number
  rejectedRecent: number
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

function curveOf(history: { inSpeed: number; outSpeed: number }[]): { down: number[]; up: number[] } {
  const tail = Array.isArray(history) ? history.slice(-CURVE_POINTS) : []
  return {
    down: tail.map((p) => num(p?.inSpeed)),
    up: tail.map((p) => num(p?.outSpeed)),
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

/** 从 surge_build_info 拼出「Surge 5.102.0 • Build 3813」 */
function buildLabelOf(samples: MetricSample[]): string {
  try {
    const info = buildInfo(samples)
    if (!info) return ""
    const version = String(info.version ?? "").trim()
    const build = String(info.build ?? "").trim()
    if (!version) return ""
    return build ? `Surge ${version} • Build ${build}` : `Surge ${version}`
  } catch {
    return ""
  }
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
    build: buildLabelOf(samples),
    down: curve.down,
    up: curve.up,
    ifaces: ifaceListOf(src.traffic),
  }
}

// ---------- 写出 ----------

let lastWriteAt = 0
let lastConnected: boolean | null = null
let lastReloadAt = 0
let reloadBroken = false

/** 面板状态变化时调用；默认节流 5s，连接状态变化或 force 时立即写入 */
export function publishWidgetSnapshot(src: WidgetSourceState, force = false) {
  let snap: WidgetSnapshot
  try {
    snap = buildWidgetSnapshot(src)
  } catch {
    return
  }
  const now = Date.now()
  const flipped = lastConnected === null || snap.connected !== lastConnected
  if (!force && !flipped && now - lastWriteAt < CACHE_WRITE_INTERVAL_MS) return
  try {
    Storage.set(WIDGET_CACHE_KEY, snap)
    lastWriteAt = now
    lastConnected = snap.connected
  } catch {
    return
  }
  reloadWidgetsThrottled(force || flipped)
}

/** 刷新桌面小组件；节流 60s，扩展环境内失败后自动停用 */
export function reloadWidgetsThrottled(force = false) {
  if (reloadBroken) return
  const now = Date.now()
  if (!force && now - lastReloadAt < WIDGET_RELOAD_INTERVAL_MS) return
  lastReloadAt = now
  try {
    Widget.reloadUserWidgets()
  } catch {
    reloadBroken = true
  }
}
