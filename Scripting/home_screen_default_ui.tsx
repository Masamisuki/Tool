// Surge Panel 首页 Tab UI（Scripting App 首页承载，Settings 里开启 Show Home Tab 后选择本脚本）
// 与 index.tsx 的区别：组件被直接挂载到 Tab，不 present、不 exit，实例常驻。
import { Script, useEffect } from "scripting"
import { acquirePolling, initStore, refreshNow, releasePolling } from "./lib/store"
import { SurgePanelApp } from "./app"

// 顶层代码只在 Tab 首次构建时执行一次
initStore()
void refreshNow().catch(() => {})

export default function HomeScreenView() {
  useEffect(() => {
    // Tab 常驻：挂载即占住 owner（首次挂载不一定收到 selected 事件，
    // 否则 home 环境里没人启动轮询），离开首页时释放以节能，回来时再抢占
    void acquirePolling("home-tab")
    const off = Script.onHomeTabEvent((event) => {
      if (event === "selected") {
        void refreshNow().catch(() => {})
        void acquirePolling("home-tab")
      } else if (event === "deselected") {
        releasePolling("home-tab")
      }
    })
    // 组件卸载时也要释放，否则这个 owner 永远赖在集合里，轮询再也停不下来
    return () => {
      off()
      releasePolling("home-tab")
    }
  }, [])

  return <SurgePanelApp />
}
