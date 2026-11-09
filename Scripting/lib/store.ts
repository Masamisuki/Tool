// 当前实例的指标、流量、轮询；实例列表见 instances.ts
import { useEffect, useState } from "scripting"
import {
  fetchOverviewSamples,
  getRecentRequests,
  getTraffic,
  latestEngineBuildLabel,
  surgeApiErrorKind,
  surgeApiErrorMessage,
  type SurgeConfig,
  type SurgeApiErrorKind,
  type TrafficEntry,
  type TrafficSnapshot,
} from "./surgeApi"
import { appendMinuteSample, downsampleToMinute, gaugeValue, isRejectPolicy, type MetricSample, type MemoryPoint, type MemRangeMin } from "./metrics"
import {
  findInstance,
  historyKey,
  memLongKey,
  getInstanceKey,
  instanceIsReady,
  instanceToConfig,
  loadInstanceState,
  persistInstanceState,
  removeInstanceKey,
  setInstanceKey,
  EMPTY_INSTANCE,
  type SurgeInstance,
} from "./instances"
import { publishWidgetSnapshot } from "./widgetCache"

export type HistoryPoint = {
  t: number
  mem: number
  inSpeed: number
  outSpeed: number
}

export type SpeedPoint = {
  t: number
  inSpeed: number
  outSpeed: number
}

export type Prefs = {
  autoRefresh: boolean
  intervalSec: 3 | 5 | 10
  maxPoints: 180 | 360 | 720
  /** 仪表盘隐藏实例地址与本机 IP，方便截图分享 */
  hideAddresses: boolean
  /** 内存诊断查看范围（分钟） */
  memRangeMin: MemRangeMin
}

export type TabId = "dashboard" | "routing" | "activity" | "settings"
export const TAB_ORDER: TabId[] = ["dashboard", "routing", "activity", "settings"]

export type RoutingSegment = "groups" | "rules"
export type ActivitySegment = "traffic" | "connections" | "dns" | "events"
export type ConnectionsMode = "active" | "recent"

export type StoreState = {
  instances: SurgeInstance[]
  activeId: string
  config: SurgeConfig
  prefs: Prefs
  samples: MetricSample[] | null
  prevSamples: MetricSample[] | null
  updatedAt: number | null
  error: string | null
  errorKind: SurgeApiErrorKind | null
  running: boolean
  speeds: { inSpeed: number; outSpeed: number }
  peakSpeeds: { inSpeed: number; outSpeed: number }
  failedRecent: number
  rejectedRecent: number
  history: HistoryPoint[]
  memLong: MemoryPoint[]
  speedHistory: SpeedPoint[]
  traffic: TrafficSnapshot | null
  /** null=未知；true=有 /metrics；false=商店版等无该端点，仪表盘走 HTTP API 回退 */
  metricsAvailable: boolean | null
  routingSegment: RoutingSegment
  activitySegment: ActivitySegment
  connectionsMode: ConnectionsMode
  visibleTab: TabId
}

const PREFS_KEY = "surge_panel_prefs"
const DEFAULT_PREFS: Prefs = {
  autoRefresh: true,
  intervalSec: 5,
  maxPoints: 720,
  hideAddresses: false,
  memRangeMin: 60,
}

function readPrefs(): Prefs {
  const saved = Storage.get(PREFS_KEY) as Partial<Prefs> | null
  return { ...DEFAULT_PREFS, ...(saved ?? {}) }
}

export const SPEED_REFRESH_MS = 1000
export const SPEED_HISTORY_SIZE = 60

function emptySpeedHistory(now = Date.now()): SpeedPoint[] {
  const out: SpeedPoint[] = []
  for (let i = SPEED_HISTORY_SIZE; i >= 1; i--) {
    out.push({ t: now - i * SPEED_REFRESH_MS, inSpeed: 0, outSpeed: 0 })
  }
  return out
}

function maxSpeedFromHistory(history: HistoryPoint[]): { inSpeed: number; outSpeed: number } {
  let inSpeed = 0
  let outSpeed = 0
  for (const p of history) {
    if (p.inSpeed > inSpeed) inSpeed = p.inSpeed
    if (p.outSpeed > outSpeed) outSpeed = p.outSpeed
  }
  return { inSpeed, outSpeed }
}

function readHistory(id: string): HistoryPoint[] {
  const raw = Storage.get(historyKey(id))
  return Array.isArray(raw) ? (raw as HistoryPoint[]) : []
}

function writeHistory(id: string, history: HistoryPoint[]) {
  Storage.set(historyKey(id), history)
}

function readMemLong(id: string, seed?: HistoryPoint[]): MemoryPoint[] {
  const raw = Storage.get(memLongKey(id))
  if (Array.isArray(raw) && raw.length > 0) return raw as MemoryPoint[]
  const seeded = seed ? downsampleToMinute(seed) : []
  if (id && seeded.length) Storage.set(memLongKey(id), seeded)
  return seeded
}

function writeMemLong(id: string, series: MemoryPoint[]) {
  Storage.set(memLongKey(id), series)
}

const boot = loadInstanceState()
const bootInst = findInstance(boot.instances, boot.activeId) ?? EMPTY_INSTANCE
const bootHistory = boot.activeId ? readHistory(boot.activeId) : []
const bootMemLong = boot.activeId ? readMemLong(boot.activeId, bootHistory) : []

let state: StoreState = {
  instances: boot.instances,
  activeId: boot.activeId,
  config: instanceToConfig(bootInst),
  prefs: DEFAULT_PREFS,
  samples: null,
  prevSamples: null,
  updatedAt: null,
  error: null,
  errorKind: null,
  running: false,
  speeds: { inSpeed: 0, outSpeed: 0 },
  peakSpeeds: maxSpeedFromHistory(bootHistory),
  failedRecent: 0,
  rejectedRecent: 0,
  history: bootHistory,
  memLong: bootMemLong,
  speedHistory: emptySpeedHistory(),
  traffic: null,
  metricsAvailable: null,
  routingSegment: "groups",
  activitySegment: "traffic",
  connectionsMode: "active",
  visibleTab: "dashboard",
}

const listeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setTimeout> | null = null
let speedTimer: ReturnType<typeof setTimeout> | null = null
let tickCount = 0
let started = false
let trafficInFlight = false
let authSuspended = false
let connectionGeneration = 0
let schedulerGeneration = 0
// 连续失败次数：失败越多下一次拉取越晚，避免断网时每秒一次白打请求把电量吃光
let trafficFailStreak = 0
let overviewFailStreak = 0

const TRAFFIC_BACKOFF_MAX_MS = 30_000
const OVERVIEW_BACKOFF_MAX_MS = 60_000

/** 连续失败 streak 次的等待时长：成功（streak=0）时就是基础间隔 */
function backoffDelay(streak: number, baseMs: number, maxMs: number): number {
  if (streak <= 0) return baseMs
  return Math.min(maxMs, baseMs * Math.pow(2, Math.min(streak, 10)))
}

function invalidateConnection() {
  connectionGeneration++
  trafficInFlight = false
}

function connectionIsCurrent(generation: number, activeId: string): boolean {
  return generation === connectionGeneration && activeId === state.activeId
}

function schedulerIsCurrent(generation: number): boolean {
  return generation === schedulerGeneration
}

// 采样每 intervalSec 一次，但序列化整个历史数组写 Storage 没必要那么勤：
// 攒在内存里，每 30 秒落盘一次，stopPolling / 切实例时强制 flush
const PERSIST_INTERVAL_MS = 30_000
let lastPersistAt = Date.now()

function flushHistory() {
  if (!state.activeId) return
  writeHistory(state.activeId, state.history)
  writeMemLong(state.activeId, state.memLong)
  lastPersistAt = Date.now()
}

function emit() {
  listeners.forEach((f) => f())
}

function patch(partial: Partial<StoreState>) {
  state = { ...state, ...partial }
  emit()
  // 小组件：状态变化后把精简快照写入 Storage（内部节流，不影响轮询）
  try {
    publishWidgetSnapshot({ ...state, build: latestEngineBuildLabel() })
  } catch {
    // 小组件缓存失败不影响面板本身
  }
}

function applyActive(instances: SurgeInstance[], activeId: string, extra?: Partial<StoreState>) {
  invalidateConnection()
  authSuspended = false
  if (instances.length === 0) {
    persistInstanceState([], "")
    patch({
      instances: [],
      activeId: "",
      config: instanceToConfig(EMPTY_INSTANCE),
      history: [],
      memLong: [],
      speedHistory: emptySpeedHistory(),
      peakSpeeds: { inSpeed: 0, outSpeed: 0 },
      samples: null,
      prevSamples: null,
      traffic: null,
      speeds: { inSpeed: 0, outSpeed: 0 },
      failedRecent: 0,
      rejectedRecent: 0,
      error: null,
      errorKind: null,
      running: false,
      updatedAt: null,
      metricsAvailable: null,
      ...extra,
    })
    return
  }
  const inst = findInstance(instances, activeId) ?? instances[0]
  persistInstanceState(instances, inst.id)
  const history = readHistory(inst.id)
  const memLong = readMemLong(inst.id, history)
  lastPersistAt = Date.now()
  patch({
    instances,
    activeId: inst.id,
    config: instanceToConfig(inst),
    history,
    memLong,
    speedHistory: emptySpeedHistory(),
    peakSpeeds: maxSpeedFromHistory(history),
    samples: null,
    prevSamples: null,
    traffic: null,
    speeds: { inSpeed: 0, outSpeed: 0 },
    failedRecent: 0,
    rejectedRecent: 0,
    error: null,
    errorKind: null,
    running: false,
    updatedAt: null,
    metricsAvailable: null,
    ...extra,
  })
}

export function needsSetup(): boolean {
  const inst = findInstance(state.instances, state.activeId) ?? state.instances[0]
  return !instanceIsReady(inst)
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getState(): StoreState {
  return state
}

export function useStore(): StoreState {
  const [s, setS] = useState<StoreState>(getState())
  useEffect(() => subscribe(() => setS(getState())), [])
  return s
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false
    }
  }
  return true
}

/**
 * 只订阅 store 的一个切片。speedHistory 每秒 patch 一次，useStore 会让所有
 * 已挂载 Tab 每秒整体重渲染；不需要秒级数据的视图应改用本 Hook。
 * selector 需为纯函数（首次渲染时捕获，不随渲染更新）。
 */
export function useStoreSelector<T>(selector: (s: StoreState) => T): T {
  const [snap, setSnap] = useState<T>(selector(getState()))
  useEffect(() => {
    let prev = snap
    const sync = () => {
      const next = selector(getState())
      if (!shallowEqual(prev, next)) {
        prev = next
        setSnap(next)
      }
    }
    sync()
    return subscribe(sync)
  }, [])
  return snap
}

export function activeInstance(): SurgeInstance {
  return findInstance(state.instances, state.activeId) ?? state.instances[0] ?? EMPTY_INSTANCE
}

export function initStore() {
  const loaded = loadInstanceState()
  applyActive(loaded.instances, loaded.activeId, {
    prefs: readPrefs(),
  })
}

export function savePrefs(prefs: Prefs) {
  const prev = state.prefs
  Storage.set(PREFS_KEY, prefs)
  const extra: Partial<StoreState> = {}
  // 缩短历史长度时立即裁剪，图表与设置不必等下一次采样才一致
  if (prefs.maxPoints < state.history.length) {
    extra.history = state.history.slice(-prefs.maxPoints)
    if (state.activeId) writeHistory(state.activeId, extra.history)
  }
  patch({ prefs, ...extra })
  if (
    started &&
    (prefs.autoRefresh !== prev.autoRefresh || prefs.intervalSec !== prev.intervalSec)
  ) {
    restartPolling()
  }
}

export function clearHistory() {
  Storage.remove(historyKey(state.activeId))
  Storage.remove(memLongKey(state.activeId))
  patch({
    history: [],
    memLong: [],
    speedHistory: emptySpeedHistory(),
    peakSpeeds: { inSpeed: 0, outSpeed: 0 },
  })
}

export function setVisibleTab(tab: TabId) {
  if (state.visibleTab === tab) return
  patch({ visibleTab: tab })
}

/** 更新当前实例的连接字段（兼容旧 saveConfig 调用） */
export function saveConfig(config: SurgeConfig) {
  const { key, ...connection } = config
  updateInstance(state.activeId, connection, key)
}

export function updateInstance(id: string, patchInst: Partial<SurgeInstance>, key?: string) {
  const previous = findInstance(state.instances, id)
  if (!previous) throw new Error("实例不存在")
  const previousKey = getInstanceKey(id)
  if (key !== undefined && !setInstanceKey(id, key)) {
    throw new Error("无法将 API Key 写入系统钥匙串，请更新 Scripting 后重试")
  }
  const instances = state.instances.map((i) => (i.id === id ? { ...i, ...patchInst } : i))
  persistInstanceState(instances, state.activeId)
  const connectionChanged =
    (patchInst.protocol !== undefined && patchInst.protocol !== previous.protocol) ||
    (patchInst.host !== undefined && patchInst.host !== previous.host) ||
    (patchInst.port !== undefined && patchInst.port !== previous.port) ||
    (key !== undefined && key !== previousKey)
  if (id === state.activeId) {
    const inst = findInstance(instances, id)!
    if (connectionChanged) invalidateConnection()
    patch(connectionChanged ? { instances, config: instanceToConfig(inst) } : { instances })
    if (connectionChanged) {
      authSuspended = false
      void connectActive()
    }
  } else {
    patch({ instances })
  }
}

export function addInstance(inst: SurgeInstance, key: string) {
  if (!setInstanceKey(inst.id, key)) {
    throw new Error("无法将 API Key 写入系统钥匙串，请更新 Scripting 后重试")
  }
  const instances = [...state.instances, inst]
  persistInstanceState(instances, state.activeId)
  patch({ instances })
}

export async function connectActive() {
  if (!instanceIsReady(activeInstance())) return
  authSuspended = false
  if (started) await refreshNow()
  else await startPolling()
}

export async function switchInstance(id: string) {
  if (id === state.activeId) return
  stopPolling()
  applyActive(state.instances, id)
  await connectActive()
}

export async function deleteInstance(id: string) {
  const instances = state.instances.filter((i) => i.id !== id)
  if (id === state.activeId || instances.length === 0) {
    // 先停轮询（flush 会写当前实例的键），再删除键，避免刚删又被写回
    stopPolling()
    Storage.remove(historyKey(id))
    Storage.remove(memLongKey(id))
    applyActive(instances, instances[0]?.id ?? "")
    await connectActive()
  } else {
    Storage.remove(historyKey(id))
    Storage.remove(memLongKey(id))
    persistInstanceState(instances, state.activeId)
    patch({ instances })
  }
  removeInstanceKey(id)
}

// ---------- Tab 跳转 ----------

let tabJump: ((tab: TabId) => void) | null = null

export function registerTabJump(fn: (tab: TabId) => void) {
  tabJump = fn
  return () => {
    if (tabJump === fn) tabJump = null
  }
}

export function setRoutingSegment(segment: RoutingSegment) {
  if (state.routingSegment === segment) return
  patch({ routingSegment: segment })
}

export function setActivitySegment(segment: ActivitySegment) {
  if (state.activitySegment === segment) return
  patch({ activitySegment: segment })
}

export function setConnectionsMode(mode: ConnectionsMode) {
  if (state.connectionsMode === mode) return
  patch({ connectionsMode: mode })
}

/** 跳到「活动」Tab 的指定分段；连接分段可顺带指定活动 / 最近 */
export function openActivity(segment: ActivitySegment, mode?: ConnectionsMode) {
  patch(mode ? { activitySegment: segment, connectionsMode: mode } : { activitySegment: segment })
  tabJump?.("activity")
}

// ---------- 实时速率 ----------

function aggregateCurrentSpeeds(entries: Record<string, TrafficEntry>): {
  inSpeed: number
  outSpeed: number
} {
  let inSpeed = 0
  let outSpeed = 0
  for (const name in entries) {
    const e = entries[name]
    inSpeed += e.inCurrentSpeed
    outSpeed += e.outCurrentSpeed
  }
  return { inSpeed, outSpeed }
}

function connectionErrorState(error: unknown): Pick<StoreState, "error" | "errorKind" | "running" | "updatedAt"> {
  const kind = surgeApiErrorKind(error)
  if (kind === "auth") authSuspended = true
  return {
    error: surgeApiErrorMessage(error),
    errorKind: kind,
    running: state.traffic !== null,
    updatedAt: Date.now(),
  }
}

async function tickTraffic(): Promise<{ elapsed: number; ok: boolean } | undefined> {
  if (needsSetup() || trafficInFlight || authSuspended) return
  const generation = connectionGeneration
  const activeId = state.activeId
  const config = state.config
  trafficInFlight = true
  const t0 = Date.now()
  let ok = false
  try {
    const traffic = await getTraffic(config)
    if (!connectionIsCurrent(generation, activeId)) return
    const source =
      traffic.interface && Object.keys(traffic.interface).length > 0
        ? traffic.interface
        : traffic.connector
    const { inSpeed, outSpeed } = aggregateCurrentSpeeds(source ?? {})
    const now = Date.now()
    const nextHistory = state.speedHistory.slice()
    nextHistory.push({ t: now, inSpeed, outSpeed })
    while (nextHistory.length > SPEED_HISTORY_SIZE) nextHistory.shift()
    patch({
      traffic,
      speeds: { inSpeed, outSpeed },
      speedHistory: nextHistory,
      peakSpeeds: {
        inSpeed: Math.max(state.peakSpeeds.inSpeed, inSpeed),
        outSpeed: Math.max(state.peakSpeeds.outSpeed, outSpeed),
      },
      running: true,
      updatedAt: now,
    })
    ok = true
  } catch (e) {
    if (!connectionIsCurrent(generation, activeId)) return
    const kind = surgeApiErrorKind(e)
    if (!state.samples || kind === "auth") {
      patch(connectionErrorState(e))
    }
  } finally {
    if (connectionIsCurrent(generation, activeId)) trafficInFlight = false
  }
  if (ok) trafficFailStreak = 0
  else trafficFailStreak++
  return { elapsed: Date.now() - t0, ok }
}

function armTraffic(delay: number) {
  if (!started || !state.prefs.autoRefresh || authSuspended) return
  const generation = connectionGeneration
  const scheduler = schedulerGeneration
  const activeId = state.activeId
  speedTimer = setTimeout(async () => {
    if (
      !started ||
      !state.prefs.autoRefresh ||
      authSuspended ||
      !schedulerIsCurrent(scheduler) ||
      !connectionIsCurrent(generation, activeId)
    ) return
    const r = await tickTraffic()
    if (!schedulerIsCurrent(scheduler) || !connectionIsCurrent(generation, activeId)) return
    // 成功：扣掉本轮耗时，维持 1s 节奏；失败：1s → 2 → 4 → 8 → 16 → 30s 指数退避
    const next =
      r && !r.ok
        ? backoffDelay(trafficFailStreak, SPEED_REFRESH_MS, TRAFFIC_BACKOFF_MAX_MS)
        : Math.max(0, SPEED_REFRESH_MS - (r?.elapsed ?? 0))
    armTraffic(next)
  }, delay)
}

async function tick(): Promise<boolean> {
  if (needsSetup() || authSuspended) return false
  const generation = connectionGeneration
  const { config, prefs, samples: prev, history, speeds, activeId, metricsAvailable, traffic } = state
  const now = Date.now()
  let ok = false
  try {
    const { samples, fromMetrics } = await fetchOverviewSamples(config, {
      skipMetrics: metricsAvailable === false,
      traffic,
    })
    if (!connectionIsCurrent(generation, activeId)) return false
    const mem = fromMetrics ? gaugeValue(samples, "surge_memory_bytes") : null
    let newHistory = history
    let newMemLong = state.memLong
    if (mem !== null) {
      const point: HistoryPoint = { t: now, mem, inSpeed: speeds.inSpeed, outSpeed: speeds.outSpeed }
      newHistory = [...history, point]
      while (newHistory.length > prefs.maxPoints) newHistory.shift()
      newMemLong = appendMinuteSample(state.memLong, { t: now, mem })
      if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
        writeHistory(activeId, newHistory)
        writeMemLong(activeId, newMemLong)
        lastPersistAt = now
      }
    }
    patch({
      samples,
      prevSamples: prev ?? null,
      updatedAt: now,
      error: null,
      errorKind: null,
      running: true,
      history: newHistory,
      memLong: newMemLong,
      metricsAvailable: fromMetrics,
    })
    ok = true
  } catch (e) {
    if (!connectionIsCurrent(generation, activeId)) return false
    patch(connectionErrorState(e))
    if (surgeApiErrorKind(e) === "auth") return false
  }

  tickCount++
  // 活动 → 连接可见时由该页自己轮询，这里不再重复拉最近请求
  const connectionsVisible = state.visibleTab === "activity" && state.activitySegment === "connections"
  if (tickCount % 3 === 1 && !connectionsVisible) {
    try {
      const { requests } = await getRecentRequests(config)
      if (!connectionIsCurrent(generation, activeId)) return false
      patch({
        failedRecent: requests.filter((r) => r.failed).length,
        rejectedRecent: requests.filter((r) => r.rejected || isRejectPolicy(r.policyName)).length,
      })
    } catch {
      // 忽略
    }
  }
  if (ok) overviewFailStreak = 0
  else overviewFailStreak++
  return ok
}

function scheduleNext() {
  if (!started || !state.prefs.autoRefresh || authSuspended) return
  const generation = connectionGeneration
  const scheduler = schedulerGeneration
  const activeId = state.activeId
  pollTimer = setTimeout(async () => {
    if (
      !started ||
      !schedulerIsCurrent(scheduler) ||
      !connectionIsCurrent(generation, activeId)
    ) return
    await tick()
    if (
      !started ||
      !schedulerIsCurrent(scheduler) ||
      !connectionIsCurrent(generation, activeId)
    ) return
    scheduleNext()
  }, backoffDelay(overviewFailStreak, state.prefs.intervalSec * 1000, OVERVIEW_BACKOFF_MAX_MS))
}

function clearTimers() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (speedTimer) {
    clearTimeout(speedTimer)
    speedTimer = null
  }
}

function restartPolling() {
  schedulerGeneration++
  clearTimers()
  scheduleNext()
  armTraffic(SPEED_REFRESH_MS)
}

export async function startPolling() {
  if (started) return
  if (needsSetup()) return
  authSuspended = false
  trafficFailStreak = 0
  overviewFailStreak = 0
  started = true
  schedulerGeneration++
  const generation = connectionGeneration
  const scheduler = schedulerGeneration
  const activeId = state.activeId
  await Promise.all([tick(), tickTraffic()])
  if (
    !started ||
    !schedulerIsCurrent(scheduler) ||
    !connectionIsCurrent(generation, activeId)
  ) return
  scheduleNext()
  armTraffic(SPEED_REFRESH_MS)
}

export function stopPolling() {
  started = false
  schedulerGeneration++
  invalidateConnection()
  clearTimers()
  flushHistory()
  // 退出前把最后的快照落盘，小组件不会停在旧数据
  try {
    publishWidgetSnapshot({ ...state, build: latestEngineBuildLabel() }, true)
  } catch {
    // 忽略
  }
}

export async function refreshNow() {
  if (needsSetup()) return
  schedulerGeneration++
  if (started) clearTimers()
  invalidateConnection()
  const generation = connectionGeneration
  const scheduler = schedulerGeneration
  const activeId = state.activeId
  authSuspended = false
  trafficFailStreak = 0
  overviewFailStreak = 0
  if (state.metricsAvailable === false) patch({ metricsAvailable: null })
  await Promise.all([tick(), tickTraffic()])
  if (
    started &&
    !authSuspended &&
    schedulerIsCurrent(scheduler) &&
    connectionIsCurrent(generation, activeId)
  ) restartPolling()
}
