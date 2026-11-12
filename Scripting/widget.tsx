// Surge Panel 小组件：优先自己取数（小组件进程内直接请求 Surge HTTP API），
// 取数失败才回退 lib/widgetCache.ts 里的缓存快照；并用 after 策略预约下一次刷新。
import { Image, Text, VStack, Widget } from "scripting"
import { loadWidgetSettings, loadWidgetSnapshot, type WidgetSettings, type WidgetSnapshot } from "./lib/widgetCache"
import { fetchLiveSnapshot } from "./lib/widgetLive"
import { formatBytes } from "./widget/format"
import { EmptyState } from "./widget/primitives"
import { LargeView, MediumView, SmallView, type WidgetViewProps } from "./widget/views"

/** 预约下一次刷新的间隔：与原版 Surge Metrics 一致，5 分钟 */
const REFRESH_MINUTES = 5
const REFRESH_MS = REFRESH_MINUTES * 60_000
/** 缓存超过这个时长才标记为「缓存」：给系统推迟刷新的余量，避免刚刷新就显示成缓存 */
const FRESH_WINDOW_MS = REFRESH_MS + 7 * 60_000

function propsOf(snapshot: WidgetSnapshot, settings: WidgetSettings): WidgetViewProps {
  const fresh = snapshot.ts > 0 && Date.now() - snapshot.ts < FRESH_WINDOW_MS
  const live = fresh && snapshot.connected
  return {
    snapshot: snapshot.ts > 0 ? snapshot : null,
    live,
    errorText: live ? "" : snapshot.error,
    settings,
  }
}

function AccessoryInline({ snapshot }: { snapshot: WidgetSnapshot }) {
  if (!snapshot.connected) return <Text>Surge 离线</Text>
  return <Text>{`Surge ↓ ${formatBytes(snapshot.inSpeed, 0)}/s`}</Text>
}

function AccessoryCircular({ snapshot }: { snapshot: WidgetSnapshot }) {
  return (
    <VStack alignment="center" spacing={0}>
      <Image systemName={snapshot.connected ? "speedometer" : "exclamationmark.circle"} />
      <Text font="caption2" fontWeight="bold">
        {snapshot.connected ? formatBytes(snapshot.inSpeed, 0) : "—"}
      </Text>
    </VStack>
  )
}

function AccessoryRectangular({ snapshot }: { snapshot: WidgetSnapshot }) {
  const requests = snapshot.activeRequests < 0 ? "—" : String(Math.round(snapshot.activeRequests))
  return (
    <VStack alignment="leading" spacing={1}>
      <Text font="headline" fontWeight="bold">
        {snapshot.instance || "Surge Panel"}
      </Text>
      <Text font="caption">
        {snapshot.connected
          ? `↓ ${formatBytes(snapshot.inSpeed, 0)}/s · ↑ ${formatBytes(snapshot.outSpeed, 0)}/s`
          : "暂无数据"}
      </Text>
      <Text font="caption2">
        {snapshot.connected ? `${requests} 请求 · 累计 ${formatBytes(snapshot.totalIn, 0)}` : "先运行一次 Surge Panel"}
      </Text>
    </VStack>
  )
}

function WidgetView({ snapshot, settings }: { snapshot: WidgetSnapshot; settings: WidgetSettings }) {
  const family = String(Widget.family || "systemMedium").toLowerCase()
  const props = propsOf(snapshot, settings)

  if (family.includes("accessoryinline")) return <AccessoryInline snapshot={snapshot} />
  if (family.includes("accessorycircular")) return <AccessoryCircular snapshot={snapshot} />
  if (family.includes("accessoryrectangular")) return <AccessoryRectangular snapshot={snapshot} />

  if (!props.snapshot) {
    return (
      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        widgetBackground="systemBackground"
        widgetURL="scripting:///run/Surge%20Panel"
      >
        <EmptyState
          title="暂无数据"
          detail={snapshot.ts > 0 ? "打开 Surge Panel 刷新一次数据" : "打开脚本填写 Surge HTTP API"}
        />
      </VStack>
    )
  }

  if (family.includes("small")) return <SmallView {...props} />
  if (family.includes("large")) return <LargeView {...props} />
  return <MediumView {...props} />
}

/**
 * 先准备一份可用的快照（缓存或实时），再 present。
 * 小组件里 hooks 不生效，且 present 之后执行上下文立即销毁，所以取数必须在 present 之前 await 完成。
 */
async function run() {
  const settings = loadWidgetSettings()
  const cached = loadWidgetSnapshot()
  let snapshot: WidgetSnapshot = cached
  try {
    const live = await fetchLiveSnapshot()
    // 取数成功：用新数据；失败但有原因：在旧数据上标注，让界面上能看出为什么没更新
    if (live.snapshot) snapshot = live.snapshot
    else if (live.error) snapshot = { ...cached, error: live.error }
  } catch {}

  try {
    // 必须用嵌套的 reloadPolicy：扁平写法在原生侧取不到 options.reloadPolicy，
    // 会被当成默认 atEnd（只有一条 timeline，永不请求下一次刷新）。
    Widget.present(<WidgetView snapshot={snapshot} settings={settings} />, {
      reloadPolicy: {
        policy: "after",
        date: new Date(Date.now() + REFRESH_MS),
      },
    })
  } catch {}
}

run()
