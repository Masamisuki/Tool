// Surge Panel 主界面（index.tsx 全屏运行与 home_screen_default_ui.tsx 首页 Tab 共用）
import {
  Button,
  HStack,
  Image,
  Navigation,
  NavigationStack,
  Picker,
  Script,
  Tab,
  TabView,
  Text,
  Toolbar,
  ToolbarItem,
  useEffect,
  useObservable,
  VStack,
} from "scripting"
import { startPolling, stopPolling, registerTabJump, setVisibleTab, TAB_ORDER, type TabId } from "./lib/store"
import { TONES } from "./lib/ui"
import { useMarkdownReleaseNotesSheet } from "./components/ReleaseNotesSheet"
import { ConnectionPill } from "./components/ConnectionStatus"
import { PAGE_BG } from "./components/Kit"
import { DashboardView } from "./views/DashboardView"
import { RoutingView } from "./views/RoutingView"
import { ActivityView } from "./views/ActivityView"
import { SettingsView } from "./views/SettingsView"

const TABS: Record<TabId, { title: string; icon: string }> = {
  dashboard: { title: "仪表盘", icon: "gauge.with.dots.needle.67percent" },
  routing: { title: "分流", icon: "arrow.triangle.branch" },
  activity: { title: "活动", icon: "waveform.path.ecg" },
  settings: { title: "设置", icon: "gearshape" },
}

function tabContent(tab: TabId) {
  switch (tab) {
    case "dashboard":
      return <DashboardView />
    case "routing":
      return <RoutingView />
    case "activity":
      return <ActivityView />
    case "settings":
      return <SettingsView />
  }
}

export function SurgePanelApp() {
  const dismiss = Navigation.useDismiss()
  // TabView 以序号驱动；业务侧只用 TabId，经 TAB_ORDER 换算
  const selection = useObservable<number>(0)
  // 首页 Tab 环境（Scripting App 首页承载）：改用顶部分段选择器，避免与 App 底栏叠出双层标签栏
  const isHome = Script.env === "home_screen"
  const releaseNotes = useMarkdownReleaseNotesSheet({
    markdownFile: "changelog.md",
    storageKey: "surge-panel:release-notes:last-seen-hash",
    title: "更新说明",
  })

  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [])

  useEffect(() => registerTabJump((tab) => selection.setValue(TAB_ORDER.indexOf(tab))), [])

  useEffect(() => {
    setVisibleTab(TAB_ORDER[selection.value] ?? "dashboard")
  }, [selection.value])

  // ---------- 首页 Tab：顶部分段器 + 状态胶囊 + 左右滑动翻页 ----------
  // Scripting 底栏是浮层：保留可见，同时忽略 container 底部安全区，让内容铺到屏幕底
  if (isHome) {
    return (
      <NavigationStack
        tabBarVisibility="visible"
        ignoresSafeArea={{ regions: "container", edges: "bottom" }}
      >
        <VStack
          spacing={0}
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          tabBarVisibility="visible"
          ignoresSafeArea={{ regions: "container", edges: "bottom" }}
          scrollEdgeEffectHidden="bottom"
          background={PAGE_BG}
          sheet={releaseNotes}
        >
          <HStack spacing={10} padding={{ horizontal: 16, top: 8, bottom: 6 }}>
            <Picker
              label={<Text>页面切换</Text>}
              pickerStyle="segmented"
              value={String(selection.value)}
              onChanged={(v: string) => selection.setValue(Number(v))}
              frame={{ maxWidth: "infinity" }}
            >
              {TAB_ORDER.map((id, i) => (
                <Text key={id} tag={String(i)}>{TABS[id].title}</Text>
              ))}
            </Picker>
            <ConnectionPill compact />
          </HStack>
          <TabView
            selection={selection}
            tabViewStyle="page"
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            ignoresSafeArea={{ regions: "container", edges: "bottom" }}
            scrollEdgeEffectHidden="bottom"
          >
            {TAB_ORDER.map((id, i) => (
              <Tab key={id} title={TABS[id].title} value={i}>
                {tabContent(id)}
              </Tab>
            ))}
          </TabView>
        </VStack>
      </NavigationStack>
    )
  }

  // ---------- 全屏运行：原生底部 TabView ----------
  const toolbar = (
    <Toolbar>
      <ToolbarItem placement="topBarLeading" sharedBackgroundVisibility="visible">
        <Button
          action={() => dismiss()}
          buttonStyle="plain"
          frame={{ width: 44, height: 44 }}
          contentShape="rect"
          accessibilityLabel="关闭"
        >
          <Image systemName="xmark" font="headline" foregroundStyle="label" />
        </Button>
      </ToolbarItem>

      {Script.supportsMinimization() ? (
        <ToolbarItem placement="topBarTrailing" sharedBackgroundVisibility="visible">
          <Button
            action={() => {
              if (!Script.isMinimized()) Script.minimize().catch(() => {})
            }}
            buttonStyle="plain"
            frame={{ width: 44, height: 44 }}
            contentShape="rect"
            accessibilityLabel="最小化"
          >
            <Image
              systemName="arrow.down.right.and.arrow.up.left"
              font="headline"
              foregroundStyle="label"
            />
          </Button>
        </ToolbarItem>
      ) : undefined}
    </Toolbar>
  )

  return (
    <NavigationStack>
      <TabView
        selection={selection}
        tint={TONES.accent.fg}
        toolbar={toolbar}
        tabBarMinimizeBehavior="onScrollDown"
        scrollEdgeEffectHidden="bottom"
        ignoresSafeArea={{ regions: "container", edges: "bottom" }}
        sheet={releaseNotes}
      >
        {TAB_ORDER.map((id, i) => (
          <Tab key={id} title={TABS[id].title} systemImage={TABS[id].icon} value={i}>
            {tabContent(id)}
          </Tab>
        ))}
      </TabView>
    </NavigationStack>
  )
}
