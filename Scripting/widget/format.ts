// 小组件内使用的格式化工具（与面板共用一套口径，避免引入 lib/metrics 的重量级依赖）
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : digits)
  return `${text} ${units[unit]}`
}

export function formatDetailBytes(bytes: number | null | undefined, digits = 2): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} ${units[unit]}`
  const digitsForUnit = unit === 1 ? Math.min(1, digits) : digits
  return `${value.toFixed(digitsForUnit)} ${units[unit]}`
}

export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  return formatBytes(bytes, bytes >= 100 * 1024 * 1024 ? 0 : 1)
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—"
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}m`
}

/** 毫秒时间戳 → 「10:24」或「3/8 10:24」 */
export function formatFetchedAt(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—"
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return "—"

  const now = new Date()
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return `${hour}:${minute}`

  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${month}/${day} ${hour}:${minute}`
}
