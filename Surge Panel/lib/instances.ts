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

function keychainGet(id: string): string | null {
  try {
    if (typeof Keychain === "undefined") return null
    return Keychain.get(credentialKey(id))
  } catch {
    return null
  }
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

function isInstance(v: unknown): v is SurgeInstance {
  if (!v || typeof v !== "object") return false
  const o = v as SurgeInstance
  return typeof o.id === "string" && typeof o.host === "string"
}

export function loadInstanceState(): { instances: SurgeInstance[]; activeId: string } {
  const raw = Storage.get(INSTANCES_KEY)
  if (Array.isArray(raw) && raw.every(isInstance)) {
    credentialWarning = null
    const instances = (raw as StoredSurgeInstance[]).map(({ key: _key, ...instance }) => instance)
    if (instances.length === 0) {
      Storage.remove(LEGACY_CONFIG_KEY)
      Storage.remove(LEGACY_HISTORY_KEY)
      return { instances: [], activeId: "" }
    }
    let migrated = false
    for (const stored of raw as StoredSurgeInstance[]) {
      if (!stored.key || keychainGet(stored.id)) continue
      if (setInstanceKey(stored.id, stored.key)) migrated = true
      else credentialWarning = "旧版 API Key 暂未迁入系统钥匙串，请更新 Scripting 后重试"
    }
    const savedId = Storage.get(ACTIVE_ID_KEY) as string | null
    const activeId = savedId && instances.some((i) => i.id === savedId) ? savedId : instances[0].id
    if (migrated) persistInstanceState(instances, activeId)
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
  credentialWarning = secured ? null : "旧版 API Key 暂未迁入系统钥匙串，请更新 Scripting 后重试"
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
    if (keychainGet(instance.id) !== null) return instance
    const fallback = oldItems.find((item) => item?.id === instance.id)?.key
    return fallback ? { ...instance, key: fallback } : instance
  })
  Storage.set(INSTANCES_KEY, stored)
  Storage.set(ACTIVE_ID_KEY, activeId)
}

export function findInstance(instances: SurgeInstance[], id: string): SurgeInstance | undefined {
  return instances.find((i) => i.id === id)
}
