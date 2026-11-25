// 多实例：CRUD、旧单配置迁移、按实例存历史
import { DEFAULT_CONFIG, type SurgeConfig } from "./surgeApi"
import { formatEndpoint } from "./connection"

export type SurgeInstance = {
  id: string
  name: string
  protocol: "http" | "https"
  host: string
  port: string
  deviceName?: string
  version?: string
  build?: string
  lastSeenAt?: number
  lastLatencyMs?: number
  lastError?: string
  lastErrorAt?: number
}

type StoredSurgeInstance = SurgeInstance & { key?: string }

export const INSTANCES_KEY = "surge_panel_instances"
export const ACTIVE_ID_KEY = "surge_panel_active_id"
export const LEGACY_CONFIG_KEY = "surge_panel_config"
export const LEGACY_HISTORY_KEY = "surge_panel_history"
const CREDENTIAL_PREFIX = "surge_panel_api_key:"
let credentialWarning: string | null = null

export function historyKey(id: string): string {
  return `surge_panel_history:${id}`
}

export function memLongKey(id: string): string {
  return `surge_panel_mem_long:${id}`
}

export function newInstanceId(): string {
  return `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function credentialKey(id: string): string {
  return `${CREDENTIAL_PREFIX}${id}`
}

const MIGRATE_WARNING = "旧版 API Key 暂未迁入系统钥匙串，请更新 Scripting 后重试"
export const KEYCHAIN_UNAVAILABLE_WARNING =
  "系统钥匙串不可用：API Key 只能以明文保存在本地配置里，请升级 Scripting 后重新保存"

/** 钥匙串读结果三态：不可用（ok=false）与「不存在」（value=null）不是一回事 */
type KeychainRead = { ok: true; value: string | null } | { ok: false }

function keychainRead(id: string): KeychainRead {
  try {
    if (typeof Keychain === "undefined") return { ok: false }
    return { ok: true, value: Keychain.get(credentialKey(id)) }
  } catch {
    return { ok: false }
  }
}

function keychainGet(id: string): string | null {
  const read = keychainRead(id)
  return read.ok ? read.value : null
}

function legacyStoredKey(id: string): string {
  const raw = Storage.get(INSTANCES_KEY)
  if (!Array.isArray(raw)) return ""
  const found = (raw as StoredSurgeInstance[]).find((item) => item?.id === id)
  return typeof found?.key === "string" ? found.key : ""
}

/** Keychain 不可用时只读取尚未迁移的旧 Storage 值，绝不创建新的明文凭据。 */
export function getInstanceKey(id: string): string {
  return keychainGet(id) ?? legacyStoredKey(id)
}

export function setInstanceKey(id: string, value: string): boolean {
  try {
    if (typeof Keychain === "undefined") return false
    if (!value) return Keychain.remove(credentialKey(id))
    return Keychain.set(credentialKey(id), value) && Keychain.get(credentialKey(id)) === value
  } catch {
    return false
  }
}

export function removeInstanceKey(id: string): boolean {
  try {
    return typeof Keychain === "undefined" ? false : Keychain.remove(credentialKey(id))
  } catch {
    return false
  }
}

export function getCredentialWarning(): string | null {
  return credentialWarning
}

export function instanceToConfig(i: SurgeInstance): SurgeConfig {
  return { protocol: i.protocol, host: i.host, port: i.port, key: getInstanceKey(i.id) }
}

export function defaultInstance(): SurgeInstance {
  return {
    id: newInstanceId(),
    name: "本机",
    protocol: DEFAULT_CONFIG.protocol,
    host: DEFAULT_CONFIG.host,
    port: DEFAULT_CONFIG.port,
  }
}

export function instanceSubtitle(i: SurgeInstance): string {
  const addr = formatEndpoint(i.host, i.port)
  if (i.deviceName) return `${i.deviceName} · ${addr}`
  if (i.version) return `v${i.version} · ${addr}`
  return addr
}

function sanitizeInstance(v: unknown): SurgeInstance | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const str = (x: unknown): string => (typeof x === "string" ? x : "")
  const numOr = (x: unknown): number | undefined =>
    typeof x === "number" && isFinite(x) ? x : undefined
  const id = str(o.id).trim()
  const host = str(o.host).trim()
  if (!id || !host) return null
  const portText = str(o.port).trim()
  const inst: SurgeInstance = {
    id,
    name: str(o.name).trim() || host,
    protocol: str(o.protocol) === "https" ? "https" : "http",
    host,
    port: portText || (typeof o.port === "number" ? String(o.port) : DEFAULT_CONFIG.port),
  }
  const deviceName = str(o.deviceName)
  if (deviceName) inst.deviceName = deviceName
  const version = str(o.version)
  if (version) inst.version = version
  const build = str(o.build)
  if (build) inst.build = build
  const lastSeenAt = numOr(o.lastSeenAt)
  if (lastSeenAt !== undefined) inst.lastSeenAt = lastSeenAt
  const lastLatencyMs = numOr(o.lastLatencyMs)
  if (lastLatencyMs !== undefined) inst.lastLatencyMs = lastLatencyMs
  const lastError = str(o.lastError)
  if (lastError) inst.lastError = lastError
  const lastErrorAt = numOr(o.lastErrorAt)
  if (lastErrorAt !== undefined) inst.lastErrorAt = lastErrorAt
  return inst
}

export function loadInstanceState(): { instances: SurgeInstance[]; activeId: string } {
  const raw = Storage.get(INSTANCES_KEY)
  // 钥匙串根本不可用时一直提示，别让用户以为 Key 已经安全存进去了
  const keychainOk = keychainRead("__probe__").ok
  credentialWarning = keychainOk ? null : KEYCHAIN_UNAVAILABLE_WARNING
  if (Array.isArray(raw)) {
    // 单条脏数据不该把整份配置丢掉：逐条修复，能救的都留下，按 id 去重
    const seen = new Set<string>()
    const instances: SurgeInstance[] = []
    const salvage: StoredSurgeInstance[] = []
    for (const item of raw as unknown[]) {
      const clean = sanitizeInstance(item)
      if (!clean || seen.has(clean.id)) continue
      seen.add(clean.id)
      instances.push(clean)
      const key = (item as StoredSurgeInstance).key
      if (typeof key === "string" && key) salvage.push({ ...clean, key })
    }
    if (instances.length === 0) {
      Storage.remove(LEGACY_CONFIG_KEY)
      Storage.remove(LEGACY_HISTORY_KEY)
      return { instances: [], activeId: "" }
    }
    let migrated = false
    for (const stored of salvage) {
      const read = keychainRead(stored.id)
      if (!read.ok || read.value) continue
      if (setInstanceKey(stored.id, stored.key as string)) migrated = true
      else if (keychainOk) credentialWarning = MIGRATE_WARNING
    }
    const savedId = Storage.get(ACTIVE_ID_KEY) as string | null
    const activeId = savedId && instances.some((i) => i.id === savedId) ? savedId : instances[0].id
    // 迁移过或修复过就回写一次，以后不必重复修
    if (migrated || instances.length !== raw.length) persistInstanceState(instances, activeId)
    Storage.remove(LEGACY_CONFIG_KEY)
    Storage.remove(LEGACY_HISTORY_KEY)
    return { instances, activeId }
  }

  const legacy = Storage.get(LEGACY_CONFIG_KEY) as SurgeConfig | null
  // 仅在旧版确实保存过连接时迁移；全新安装保持空列表，避免立刻去连
  if (!legacy || (!legacy.key?.trim() && !legacy.host?.trim())) {
    return { instances: [], activeId: "" }
  }
  const inst: SurgeInstance = {
    id: newInstanceId(),
    name: "本机",
    protocol: legacy.protocol ?? DEFAULT_CONFIG.protocol,
    host: legacy.host ?? DEFAULT_CONFIG.host,
    port: legacy.port ?? DEFAULT_CONFIG.port,
  }
  const legacyKey = legacy.key ?? DEFAULT_CONFIG.key
  const secured = !legacyKey || setInstanceKey(inst.id, legacyKey)
  // 失败只可能是钥匙串不可用，此时提示要指向真实原因
  credentialWarning = secured ? (keychainOk ? null : KEYCHAIN_UNAVAILABLE_WARNING) : KEYCHAIN_UNAVAILABLE_WARNING
  const legacyHist = Storage.get(LEGACY_HISTORY_KEY)
  if (Array.isArray(legacyHist)) {
    Storage.set(historyKey(inst.id), legacyHist)
  }
  if (secured) persistInstanceState([inst], inst.id)
  else {
    Storage.set(INSTANCES_KEY, [{ ...inst, key: legacyKey }])
    Storage.set(ACTIVE_ID_KEY, inst.id)
  }
  Storage.remove(LEGACY_CONFIG_KEY)
  Storage.remove(LEGACY_HISTORY_KEY)
  return { instances: [inst], activeId: inst.id }
}

export const EMPTY_INSTANCE: SurgeInstance = {
  id: "",
  name: "未配置",
  protocol: DEFAULT_CONFIG.protocol,
  host: DEFAULT_CONFIG.host,
  port: DEFAULT_CONFIG.port,
}

export function instanceIsReady(inst: SurgeInstance | undefined): boolean {
  return !!inst && getInstanceKey(inst.id).trim().length > 0 && inst.host.trim().length > 0
}

export function persistInstanceState(instances: SurgeInstance[], activeId: string) {
  const old = Storage.get(INSTANCES_KEY)
  const oldItems = Array.isArray(old) ? (old as StoredSurgeInstance[]) : []
  const stored = instances.map((instance): StoredSurgeInstance => {
    // 三态：只有「钥匙串可用且确实存了值」才不落明文；不可用时保留旧明文，否则重启就连不上
    const read = keychainRead(instance.id)
    if (read.ok && read.value) return instance
    const fallback = oldItems.find(
      (item) => item?.id === instance.id && typeof item.key === "string" && item.key
    )?.key
    return fallback ? { ...instance, key: fallback } : instance
  })
  Storage.set(INSTANCES_KEY, stored)
  Storage.set(ACTIVE_ID_KEY, activeId)
}

export function findInstance(instances: SurgeInstance[], id: string): SurgeInstance | undefined {
  return instances.find((i) => i.id === id)
}
