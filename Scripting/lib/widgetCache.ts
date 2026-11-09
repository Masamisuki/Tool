// 小组件数据桥：面板运行时把精简后的状态写入 Storage，widget.tsx 只读缓存渲染。
// 注意：这里不引入 lib/ui.ts（它模块加载即读 Device.systemVersion），以保证小组件扩展内可安全加载。
import { Widget, type DynamicShapeStyle, type ShapeStyle } from "scripting"
import { displayHostPort, gaugeValue, type MetricSample } from "./metrics"
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

export type WidgetAccent = "indigo" | "blue" | "teal" | "green" | "orange" | "purple"

export type WidgetSettings = {
  style: "compact" | "detailed"
  accent: WidgetAccent
  showChart: boolean
  showMemory: boolean
  showUptime: boolean
  showRequests: boolean
  showTotals: boolean
  showPeak: boolean
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  style: "detailed",
  accent: "indigo",
  showChart: true,
  showMemory: true,
  showUptime: true,
  showRequests: true,
  showTotals: true,
  showPeak: true,
}

const styleOf = (light: ShapeStyle, dark: ShapeStyle): DynamicShapeStyle => ({ light, dark })

export const WIDGET_ACCENTS: { tag: WidgetAccent; label: string; style: DynamicShapeStyle }[] = [
  { tag: "indigo", label: "靛蓝", style: styleOf("#4F46E5", "#A69CFF") },
  { tag: "blue", label: "蓝色", style: styleOf("#0A6CB8", "#56C7DF") },
  { tag: "teal", label: "青色", style: styleOf("#0F8A7E", "#5FE0D0") },
  { tag: "green", label: "绿色", style: styleOf("#217A51", "#62D5A3") },
  { tag: "orange", label: "橙色", style: styleOf("#B4611A", "#FFB05C") },
  { tag: "purple", label: "紫色", style: styleOf("#7040CB", "#C0A6FF") },
]

/** 小组件内使用的强调色；返回 { light, dark } 供 DynamicShapeStyle 使用 */
export function widgetAccentColor(accent: WidgetAccent): DynamicShapeStyle {
  const hit = WIDGET_ACCENTS.find((a) => a.tag === accent) ?? WIDGET_ACCENTS[0]
  return hit.style
}

export function loadWidgetSettings(): WidgetSettings {
  const saved = (Storage.get(WIDGET_SETTINGS_KEY) as Partial<WidgetSettings> | null) ?? {}
  const d = DEFAULT_WIDGET_SETTINGS
  return {
    style: saved.style === "compact" ? "compact" : "detailed",
    accent: WIDGET_ACCENTS.some((a) => a.tag === saved.accent) ? (saved.accent as WidgetAccent) : d.accent,
    showChart: saved.showChart !== false,
    showMemory: saved.showMemory !== false,
    showUptime: saved.showUptime !== false,
    showRequests: saved.showRequests !== false,
    showTotals: saved.showTotals !== false,
    showPeak: saved.showPeak !== false,
  }
}

export function saveWidgetSettings(next: WidgetSettings) {
  const safe: WidgetSettings = {
    style: next.style === "compact" ? "compact" : "detailed",
    accent: WIDGET_ACCENTS.some((a) => a.tag === next.accent) ? next.accent : DEFAULT_WIDGET_SETTINGS.accent,
    showChart: next.showChart !== false,
    showMemory: next.showMemory !== false,
    showUptime: next.showUptime !== false,
    showRequests: next.showRequests !== false,
    showTotals: next.showTotals !== false,
    showPeak: next.showPeak !== false,
  }
  Storage.set(WIDGET_SETTINGS_KEY, safe)
  return safe
}

// ---------- 快照 ----------

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
  /** 最近的下行 / 上行速率序列（字节每秒） */
  down: number[]
  up: number[]
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
  down: [],
  up: [],
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function numbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => num(x)).slice(-CURVE_POINTS)
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
    down: numbers(raw.down),
    up: numbers(raw.up),
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
    down: curve.down,
    up: curve.up,
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
