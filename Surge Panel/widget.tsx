// Surge Panel 小组件：只读 lib/widgetCache.ts 里的缓存快照渲染，不发起任何网络请求。
import { HStack, Image, Spacer, Text, VStack, type DynamicShapeStyle, type ShapeStyle, Widget } from "scripting"
import { formatClock, formatSpeedParts, formatUptime } from "./lib/metrics"
import {
  loadWidgetSettings,
  loadWidgetSnapshot,
  widgetAccentColor,
  type WidgetSettings,
  type WidgetSnapshot,
} from "./lib/widgetCache"

const dynamic = (light: ShapeStyle, dark: ShapeStyle): DynamicShapeStyle => ({ light, dark })
const background = dynamic("#F7F5FB", "#111015")
const primary = dynamic("#17171B", "#F3F1F7")
const secondary = dynamic("#77757E", "#AAA6B2")
const downloadTint = dynamic("#0A6CB8", "#56C7DF")
const uploadTint = dynamic("#0F8A7E", "#5FE0D0")
const offlineTint = dynamic("#C0393F", "#FF7D86")

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

function sparkline(values: number[], width: number): string {
  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(v) && v >= 0) : []
  if (list.length === 0) return ""
  const points = list.slice(-Math.max(1, width))
  let max = 0
  for (const v of points) if (v > max) max = v
  const scale = Math.max(1, max)
  let out = ""
  for (const v of points) {
    const ratio = Math.sqrt(Math.max(0, v) / scale)
    const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(ratio * (BLOCKS.length - 1))))
    out += BLOCKS[idx]
  }
  return out
}

function bigText(value: number): string {
  return value < 0 ? "—" : formatSpeedParts(value).value + (formatSpeedParts(value).unit ? ` ${formatSpeedParts(value).unit}` : "")
}

function dash(value: number, format: (v: number) => string): string {
  return value < 0 ? "—" : format(value)
}

function Header({ snapshot, tint, compact = false }: { snapshot: WidgetSnapshot; tint: DynamicShapeStyle; compact?: boolean }) {
  const time = snapshot.dataAt > 0 ? formatClock(snapshot.dataAt) : "—"
  return (
    <HStack spacing={5} frame={{ maxWidth: "infinity" }}>
      <Image systemName="bolt.horizontal.circle.fill" foregroundStyle={tint} />
      <Text font={compact ? "subheadline" : "headline"} fontWeight="bold" foregroundStyle={primary} lineLimit={1} minScaleFactor={0.6}>
        {snapshot.instance || "Surge"}
      </Text>
      <Spacer />
      <Text font="caption2" foregroundStyle={snapshot.connected ? tint : offlineTint} lineLimit={1}>
        {snapshot.connected ? time : snapshot.running ? "连接中" : "离线"}
      </Text>
    </HStack>
  )
}

function SpeedTile({
  label,
  arrow,
  value,
  tint,
  big = false,
}: {
  label: string
  arrow: string
  value: number
  tint: DynamicShapeStyle
  big?: boolean
}) {
  const parts = formatSpeedParts(value)
  return (
    <VStack alignment="center" spacing={1} frame={{ maxWidth: "infinity", alignment: "center" }}>
      <Text font="caption2" foregroundStyle={secondary} lineLimit={1}>
        {`${arrow} ${label}`}
      </Text>
      <HStack spacing={2}>
        <Text font={big ? "title3" : "headline"} fontWeight="bold" foregroundStyle={tint} lineLimit={1} minScaleFactor={0.55}>
          {parts.value}
        </Text>
        {parts.unit ? (
          <Text font="caption2" foregroundStyle={secondary} lineLimit={1}>
            {parts.unit}
          </Text>
        ) : null}
      </HStack>
    </VStack>
  )
}

function StatTile({ label, value, tint }: { label: string; value: string; tint?: DynamicShapeStyle }) {
  return (
    <VStack alignment="center" spacing={1} frame={{ maxWidth: "infinity", alignment: "center" }}>
      <Text font="caption2" foregroundStyle={secondary} lineLimit={1}>
        {label}
      </Text>
      <Text font="subheadline" fontWeight="semibold" foregroundStyle={tint ?? primary} lineLimit={1} minScaleFactor={0.6}>
        {value}
      </Text>
    </VStack>
  )
}

function SpeedRow({ snapshot, big = false }: { snapshot: WidgetSnapshot; big?: boolean }) {
  return (
    <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
      <SpeedTile label="下行" arrow="↓" value={snapshot.inSpeed} tint={downloadTint} big={big} />
      <SpeedTile label="上行" arrow="↑" value={snapshot.outSpeed} tint={uploadTint} big={big} />
    </HStack>
  )
}

function Curve({ snapshot, single = false }: { snapshot: WidgetSnapshot; single?: boolean }) {
  const down = sparkline(snapshot.down, 24)
  const up = sparkline(snapshot.up, 24)
  if (!down && !up) return null
  if (single) {
    return (
      <Text font="caption2" foregroundStyle={downloadTint} lineLimit={1} minScaleFactor={0.5}>
        {down}
      </Text>
    )
  }
  return (
    <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <Text font="caption2" foregroundStyle={downloadTint} lineLimit={1} minScaleFactor={0.5}>
        {down}
      </Text>
      <Text font="caption2" foregroundStyle={uploadTint} lineLimit={1} minScaleFactor={0.5}>
        {up}
      </Text>
    </VStack>
  )
}

function OfflineView({ snapshot, tint }: { snapshot: WidgetSnapshot; tint: DynamicShapeStyle }) {
  const message = snapshot.error || (snapshot.ts > 0 ? "请打开 Surge Panel 刷新数据" : "先运行一次 Surge Panel")
  return (
    <VStack alignment="center" spacing={6} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "center" }}>
      <Header snapshot={snapshot} tint={tint} compact />
      <Spacer />
      <Image systemName="exclamationmark.circle" foregroundStyle={offlineTint} />
      <Text font="subheadline" fontWeight="semibold" foregroundStyle={primary} lineLimit={1}>
        暂无数据
      </Text>
      <Text font="caption2" foregroundStyle={secondary} lineLimit={3} minScaleFactor={0.7}>
        {message}
      </Text>
      <Spacer />
    </VStack>
  )
}

function SmallWidget({ snapshot, settings, tint }: { snapshot: WidgetSnapshot; settings: WidgetSettings; tint: DynamicShapeStyle }) {
  const info = settings.showRequests
    ? `${dash(snapshot.activeRequests, (v) => String(Math.round(v)))} 请求`
    : settings.showUptime
      ? `运行 ${dash(snapshot.uptime, (v) => formatUptime(v))}`
      : ""
  return (
    <VStack alignment="center" spacing={5} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "center" }}>
      <Header snapshot={snapshot} tint={tint} compact />
      <Spacer />
      <SpeedRow snapshot={snapshot} big={settings.style === "detailed"} />
      {settings.showChart && settings.style === "detailed" ? <Curve snapshot={snapshot} single /> : null}
      {info ? (
        <Text font="caption2" foregroundStyle={secondary} lineLimit={1} minScaleFactor={0.75}>
          {info}
        </Text>
      ) : null}
      <Spacer />
    </VStack>
  )
}

function MediumWidget({ snapshot, settings, tint }: { snapshot: WidgetSnapshot; settings: WidgetSettings; tint: DynamicShapeStyle }) {
  return (
    <VStack alignment="center" spacing={7} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
      <Header snapshot={snapshot} tint={tint} />
      <SpeedRow snapshot={snapshot} big={settings.style === "detailed"} />
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        {settings.showRequests ? <StatTile label="活动请求" value={dash(snapshot.activeRequests, (v) => String(Math.round(v)))} /> : null}
        {settings.showMemory ? <StatTile label="内存" value={dash(snapshot.memory, bigText)} /> : null}
        {settings.showUptime ? <StatTile label="运行时长" value={dash(snapshot.uptime, (v) => formatUptime(v))} /> : null}
      </HStack>
      {settings.showChart ? <Curve snapshot={snapshot} single /> : null}
      {settings.showTotals ? (
        <Text font="caption2" foregroundStyle={secondary} lineLimit={1} minScaleFactor={0.7}>
          {`累计 ↓ ${bigText(snapshot.totalIn)} · ↑ ${bigText(snapshot.totalOut)}`}
        </Text>
      ) : null}
    </VStack>
  )
}

function LargeWidget({ snapshot, settings, tint }: { snapshot: WidgetSnapshot; settings: WidgetSettings; tint: DynamicShapeStyle }) {
  return (
    <VStack alignment="center" spacing={9} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
      <Header snapshot={snapshot} tint={tint} />
      <SpeedRow snapshot={snapshot} big />
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        {settings.showRequests ? <StatTile label="活动请求" value={dash(snapshot.activeRequests, (v) => String(Math.round(v)))} /> : null}
        {settings.showMemory ? <StatTile label="内存占用" value={dash(snapshot.memory, bigText)} /> : null}
        {settings.showUptime ? <StatTile label="运行时长" value={dash(snapshot.uptime, (v) => formatUptime(v))} /> : null}
      </HStack>
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <StatTile label="DNS 缓存" value={dash(snapshot.dnsCache, (v) => String(Math.round(v)))} />
        <StatTile label="安全封禁" value={dash(snapshot.bans, (v) => String(Math.round(v)))} />
        <StatTile label="失败请求" value={String(Math.round(snapshot.failed))} />
        <StatTile label="拒绝请求" value={String(Math.round(snapshot.rejected))} />
      </HStack>
      {settings.showPeak ? (
        <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <StatTile label="峰值下行" value={bigText(snapshot.peakIn)} tint={downloadTint} />
          <StatTile label="峰值上行" value={bigText(snapshot.peakOut)} tint={uploadTint} />
          {settings.showTotals ? <StatTile label="累计下行" value={bigText(snapshot.totalIn)} /> : null}
          {settings.showTotals ? <StatTile label="累计上行" value={bigText(snapshot.totalOut)} /> : null}
        </HStack>
      ) : null}
      {settings.showChart ? <Curve snapshot={snapshot} /> : null}
      <Spacer />
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        <Text font="caption2" foregroundStyle={secondary} lineLimit={1} minScaleFactor={0.6}>
          {snapshot.endpoint || "—"}
        </Text>
        <Spacer />
        <Text font="caption2" foregroundStyle={snapshot.connected ? tint : secondary} lineLimit={1}>
          {snapshot.dataAt > 0 ? `更新 ${formatClock(snapshot.dataAt)}` : "未取数"}
        </Text>
      </HStack>
    </VStack>
  )
}

function WidgetView({ snapshot, settings }: { snapshot: WidgetSnapshot; settings: WidgetSettings }) {
  const family = Widget.family
  const tint = widgetAccentColor(settings.accent)

  if (family === "accessoryInline") {
    const parts = formatSpeedParts(snapshot.inSpeed)
    return <Text>{snapshot.connected ? `Surge ↓ ${parts.value} ${parts.unit}` : "Surge 离线"}</Text>
  }
  if (family === "accessoryCircular") {
    const parts = formatSpeedParts(snapshot.inSpeed)
    return (
      <VStack alignment="center" spacing={0}>
        <Image systemName={snapshot.connected ? "bolt.horizontal.circle.fill" : "exclamationmark.circle"} />
        <Text font="caption2" fontWeight="bold">
          {snapshot.connected ? parts.value : "—"}
        </Text>
      </VStack>
    )
  }
  if (family === "accessoryRectangular") {
    return (
      <VStack alignment="leading" spacing={1}>
        <Text font="headline" fontWeight="bold">
          {snapshot.instance || "Surge Panel"}
        </Text>
        <Text font="caption">
          {snapshot.connected ? `↓ ${bigText(snapshot.inSpeed)} · ↑ ${bigText(snapshot.outSpeed)}` : "暂无数据"}
        </Text>
        <Text font="caption2">
          {snapshot.connected ? `${Math.round(Math.max(0, snapshot.activeRequests))} 请求 · 内存 ${bigText(snapshot.memory)}` : "先运行一次 Surge Panel"}
        </Text>
      </VStack>
    )
  }

  let content
  if (!snapshot.connected) content = <OfflineView snapshot={snapshot} tint={tint} />
  else if (family === "systemSmall") content = <SmallWidget snapshot={snapshot} settings={settings} tint={tint} />
  else if (family === "systemLarge" || family === "systemExtraLarge" || family === "systemExtraLargePortrait")
    content = <LargeWidget snapshot={snapshot} settings={settings} tint={tint} />
  else content = <MediumWidget snapshot={snapshot} settings={settings} tint={tint} />

  const inset = family === "systemSmall" ? 12 : 14
  const size = Widget.displaySize
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const hideBackground = Widget.isTransparentMode || Widget.isBlurMode
  return (
    <VStack frame={{ width, height }} widgetBackground={hideBackground ? undefined : background} widgetURL="scripting:///run/Surge%20Panel">
      <VStack alignment="center" frame={{ width: Math.max(1, width - inset * 2), height: Math.max(1, height - inset * 2), alignment: "center" }}>
        {content}
      </VStack>
    </VStack>
  )
}

Widget.present(<WidgetView snapshot={loadWidgetSnapshot()} settings={loadWidgetSettings()} />, { policy: "atEnd" })
