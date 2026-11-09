// 当前实例连接状态 → 状态胶囊（首页顶栏、仪表盘、设置共用）
import { needsSetup, useStoreSelector } from "../lib/store"
import { StatusPill, type StatusKind } from "./Kit"

export function useConnectionStatus(): { kind: StatusKind; label: string } {
  const { error, running } = useStoreSelector((s) => ({
    error: s.error,
    running: s.running,
    instances: s.instances,
    activeId: s.activeId,
  }))
  if (needsSetup()) return { kind: "idle", label: "待配置" }
  if (error) return { kind: "error", label: "未连接" }
  if (running) return { kind: "ok", label: "运行中" }
  return { kind: "busy", label: "连接中" }
}

export function ConnectionPill({ compact = false }: { compact?: boolean }) {
  const s = useConnectionStatus()
  return <StatusPill kind={s.kind} label={s.label} compact={compact} />
}
