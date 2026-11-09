// 仅当前可见 Tab 按面板间隔自动刷新
// 用选择器订阅：speedHistory 每秒 patch，不能让挂了本 Hook 的长列表页每秒重渲染
import { useEffect } from "scripting"
import { needsSetup, useStoreSelector, type TabId } from "./store"

export function useTabAutoRefresh(tab: TabId, load: () => void | Promise<void>) {
  const { visibleTab, autoRefresh, intervalSec, config } = useStoreSelector((s) => ({
    visibleTab: s.visibleTab,
    autoRefresh: s.prefs.autoRefresh,
    intervalSec: s.prefs.intervalSec,
    config: s.config,
  }))
  useEffect(() => {
    if (visibleTab !== tab) return
    if (needsSetup()) return
    // 上一轮还没回来就不再叠加：慢响应（默认 30s 超时）时避免请求堆积
    let inFlight = false
    const run = async () => {
      if (inFlight || needsSetup()) return
      inFlight = true
      try {
        await load()
      } catch {
        // 失败交给页面自己展示状态，这里只保证计数复位
      } finally {
        inFlight = false
      }
    }
    void run()
    if (!autoRefresh) return
    const id = setInterval(() => {
      void run()
    }, intervalSec * 1000)
    return () => clearInterval(id)
  }, [visibleTab, autoRefresh, intervalSec, config])
}
