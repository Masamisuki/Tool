// 小组件自取数通道：小组件进程自己从 Keychain 取 API Key、直接请求 Surge HTTP API，
// 再把结果写成与面板同构的缓存快照；因此不开 App，小组件也能按时间线刷新数据。
// 与 widgetCache.ts 同样的约束：只允许引入 widget 安全的模块（不引入 lib/store.ts、lib/ui.ts，
// 它们模块加载即读 Device / 起定时器）。
import { fetch } from "scripting"
import { instanceToConfig, loadInstanceState } from "./instances"
import { parsePrometheus, type MetricSample } from "./metrics"
import {
  surgeApiErrorMessage,
  urlOf,
  type SurgeConfig,
  type TrafficEntry,
  type TrafficSnapshot,
} from "./surgeApi"
import { WIDGET_CACHE_KEY, buildWidgetSnapshot, loadWidgetSnapshot, type WidgetSnapshot } from "./widgetCache"

/** 面板的设置键，与 lib/store.ts 的 PREFS_KEY 一致，这里只读 */
const PREFS_KEY = "surge_panel_prefs"

/** 小组件的时间预算很紧：宁可用旧快照，也不要卡在这里 */
const TRAFFIC_TIMEOUT_SEC = 6
const METRICS_TIMEOUT_SEC = 5

/** 与 widgetCache.ts 的 CURVE_POINTS 保持一致 */
const CURVE_POINTS = 24

export type LiveSnapshotResult = {
  /** 取到新数据的快照；失败时为 null，调用方应回退到缓存快照 */
  snapshot: WidgetSnapshot | null
  /** 失败原因，可直接展示；成功时为空串 */
  error: string
}

async function getTrafficLive(c: SurgeConfig): Promise<TrafficSnapshot> {
  const res = await fetch(urlOf(c, "/v1/traffic"), {
    method: "GET",
    headers: { "X-Key": c.key },
    timeout: TRAFFIC_TIMEOUT_SEC,
    allowInsecureRequest: c.protocol === "http",
    debugLabel: "surge-panel widget traffic",
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("API Key 无效或没有访问权限")
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as TrafficSnapshot
}

/** 商店版没有 /v1/metrics（404），这里一律当「该指标不可用」处理，绝不抛错 */
async function getSamplesLive(c: SurgeConfig): Promise<MetricSample[] | null> {
  try {
    const res = await fetch(urlOf(c, "/v1/metrics"), {
      method: "GET",
      headers: { "X-Key": c.key },
      timeout: METRICS_TIMEOUT_SEC,
      allowInsecureRequest: c.protocol === "http",
      debugLabel: "surge-panel widget metrics",
    })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (!text || text.startsWith("{") || text.startsWith("[")) return null
    const samples = parsePrometheus(text)
    return samples.length > 0 ? samples : null
  } catch {
    return null
  }
}

function trafficTable(traffic: TrafficSnapshot): Record<string, TrafficEntry> {
  const iface = traffic.interface ?? {}
  return Object.keys(iface).length > 0 ? iface : traffic.connector ?? {}
}

/** 与 lib/store.ts 的 aggregateCurrentSpeeds 同源：逐网卡累加瞬时速率 */
function aggregateSpeeds(traffic: TrafficSnapshot): { inSpeed: number; outSpeed: number } {
  const table = trafficTable(traffic)
  let inSpeed = 0
  let outSpeed = 0
  for (const key of Object.keys(table)) {
    const entry = table[key]
    if (!entry) continue
    const i = Number(entry.inCurrentSpeed)
    const o = Number(entry.outCurrentSpeed)
    if (Number.isFinite(i)) inSpeed += i
    if (Number.isFinite(o)) outSpeed += o
  }
  return { inSpeed, outSpeed }
}

/** 在旧曲线的尾巴上追加本次采样；时间跨度随刷新间隔变粗，但趋势仍然成立 */
function nextCurve(
  prev: WidgetSnapshot,
  speeds: { inSpeed: number; outSpeed: number }
): { inSpeed: number; outSpeed: number }[] {
  const points: { inSpeed: number; outSpeed: number }[] = []
  const size = Math.min(prev.down.length, prev.up.length)
  for (let i = 0; i < size; i++) points.push({ inSpeed: prev.down[i], outSpeed: prev.up[i] })
  points.push({ inSpeed: speeds.inSpeed, outSpeed: speeds.outSpeed })
  return points.slice(-CURVE_POINTS)
}

function readHideAddresses(): boolean {
  const saved = Storage.get(PREFS_KEY) as { hideAddresses?: boolean } | null
  return saved?.hideAddresses === true
}

/**
 * 在小组件进程内取一次数：/v1/traffic（必需）+ /v1/metrics（可选），
 * 成功则写入 WIDGET_CACHE_KEY 并返回新快照，失败返回原因且不动缓存。
 */
export async function fetchLiveSnapshot(): Promise<LiveSnapshotResult> {
  try {
    const { instances, activeId } = loadInstanceState()
    if (instances.length === 0) return { snapshot: null, error: "" }
    const active = instances.find((item) => item.id === activeId) ?? instances[0]
    if (!active || !String(active.host ?? "").trim()) return { snapshot: null, error: "" }

    const config = instanceToConfig(active)
    // 两个请求并发，指标失败不影响主数据
    const samplesPromise = getSamplesLive(config)
    let traffic: TrafficSnapshot
    try {
      traffic = await getTrafficLive(config)
    } catch (error) {
      return { snapshot: null, error: surgeApiErrorMessage(error) }
    }
    const samples = await samplesPromise

    const prev = loadWidgetSnapshot()
    const speeds = aggregateSpeeds(traffic)
    const now = Date.now()
    const snapshot = buildWidgetSnapshot({
      instances: instances.map((item) => ({ id: item.id, name: item.name })),
      activeId: active.id,
      config: { host: active.host, port: active.port },
      prefs: { hideAddresses: readHideAddresses() },
      samples,
      traffic,
      speeds,
      peakSpeeds: {
        inSpeed: Math.max(prev.peakIn, speeds.inSpeed),
        outSpeed: Math.max(prev.peakOut, speeds.outSpeed),
      },
      speedHistory: nextCurve(prev, speeds),
      running: true,
      error: null,
      updatedAt: now,
      // 失败 / 拒绝计数只有 /v1/requests 才有，沿用面板上次算好的值
      failedRecent: prev.failed,
      rejectedRecent: prev.rejected,
    })

    try {
      Storage.set(WIDGET_CACHE_KEY, snapshot)
    } catch {}

    return { snapshot, error: "" }
  } catch (error) {
    return { snapshot: null, error: surgeApiErrorMessage(error) }
  }
}
