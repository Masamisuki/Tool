// Surge Panel 小组件：只读 lib/widgetCache.ts 里的缓存快照渲染，不发起任何网络请求。
import { Image, Text, VStack, Widget } from "scripting"
import { loadWidgetSettings, loadWidgetSnapshot, type WidgetSettings, type WidgetSnapshot } from "./lib/widgetCache"
import { formatBytes } from "./widget/format"
import { EmptyState } from "./widget/primitives"
import { LargeView, MediumView, SmallView, type WidgetViewProps } from "./widget/views"

/** 缓存超过这个时长就按「缓存」而不是「更新」展示 */
const FRESH_WINDOW_MS = 3 * 60_000

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

Widget.present(<WidgetView snapshot={loadWidgetSnapshot()} settings={loadWidgetSettings()} />, { policy: "atEnd" })
