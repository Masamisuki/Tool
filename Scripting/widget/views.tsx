// 小组件中/大尺寸面板：与 Surge Metrics 面板一致的排版
import { Divider, HStack, Image, Spacer, Text, VStack, ZStack } from "scripting"
import type { WidgetSnapshot, WidgetSettings } from "../lib/widgetCache"
import { formatBytes, formatDetailBytes, formatMemory, formatUptime } from "./format"
import { C, EmptyState, Header, RateCard, StatusBlock, VersionLabel } from "./primitives"

export type WidgetViewProps = {
  /** null 表示面板还没有写入过任何数据 */
  snapshot: WidgetSnapshot | null
  /** 数据是否为面板刚刚取到的实时数据 */
  live: boolean
  errorText: string
  settings: WidgetSettings
}

type IfaceTraffic = WidgetSnapshot["ifaces"][number]

const gauge = (value: number): number | null => (value >= 0 ? value : null)

function labelOf(snapshot: WidgetSnapshot): string {
  return String(snapshot.build ?? "").trim()
}

function metricBlocks(snapshot: WidgetSnapshot, settings: WidgetSettings) {
  const blocks: { icon: string; label: string; value: string; on: boolean }[] = []
  if (settings.showMemory) blocks.push({ icon: "cpu", label: "内存占用", value: formatMemory(gauge(snapshot.memory)), on: true })
  if (settings.showRequests) {
    blocks.push({
      icon: "link",
      label: "活跃请求",
      value: snapshot.activeRequests < 0 ? "—" : String(Math.round(snapshot.activeRequests)),
      on: true,
    })
  }
  if (settings.showDns) {
    blocks.push({
      icon: "globe",
      label: "DNS 缓存",
      value: snapshot.dnsCache < 0 ? "—" : String(Math.round(snapshot.dnsCache)),
      on: true,
    })
  }
  if (settings.showUptime) blocks.push({ icon: "clock", label: "运行时长", value: formatUptime(gauge(snapshot.uptime)), on: true })
  return blocks
}

function bansOf(snapshot: WidgetSnapshot): number {
  return snapshot.bans < 0 ? 0 : Math.max(0, Math.round(snapshot.bans))
}

/** 与参考一致：状态块之间插 Spacer，让四块均匀分布 */
function withSpacers(blocks: { icon: string; label: string; value: string }[]) {
  return blocks.flatMap((b, index) => {
    const node = <StatusBlock key={b.label} icon={b.icon} label={b.label} value={b.value} color={C.accent} />
    return index === 0 ? [node] : [<Spacer key={`gap-${b.label}`} />, node]
  })
}

function interfaceInfo(name: string): { title: string; icon: string } {
  const value = String(name || "unknown")
  if (/^pdp_ip\d+$/i.test(value)) return { title: "蜂窝数据", icon: "antenna.radiowaves.left.and.right" }
  if (value === "en0") return { title: "Wi-Fi", icon: "wifi" }
  if (value === "lo0") return { title: "回环接口", icon: "arrow.triangle.2.circlepath" }
  if (/^awdl\d+$/i.test(value)) return { title: "Apple 直连", icon: "dot.radiowaves.left.and.right" }
  if (/^llw\d+$/i.test(value)) return { title: "低延迟无线", icon: "wave.3.right" }
  if (/^utun\d+$/i.test(value)) return { title: "隧道", icon: "lock.shield" }
  if (/^bridge\d+$/i.test(value)) return { title: "网桥", icon: "point.3.connected.trianglepath.dotted" }
  return { title: value, icon: "network" }
}

function DirectionValue({ direction, value }: { direction: "down" | "up"; value: number }) {
  const down = direction === "down"
  return (
    <HStack
      spacing={4}
      alignment="center"
      frame={{ maxWidth: "infinity", alignment: down ? "leading" : "trailing" }}
    >
      {down ? (
        <Image systemName="arrow.down" resizable scaleToFit foregroundStyle={C.down} frame={{ width: 9, height: 9 }} />
      ) : null}
      <Text font={11} fontWeight="semibold" fontDesign="rounded" foregroundStyle={C.primary} lineLimit={1}>
        {formatDetailBytes(value, 1)}
      </Text>
      {!down ? (
        <Image systemName="arrow.up" resizable scaleToFit foregroundStyle={C.up} frame={{ width: 9, height: 9 }} />
      ) : null}
    </HStack>
  )
}

function TrafficComposition({ item }: { item: IfaceTraffic }) {
  const segments = 20
  const downCount =
    item.totalBytes > 0 ? Math.max(0, Math.min(segments, Math.round((item.inBytes / item.totalBytes) * segments))) : 0
  return (
    <HStack spacing={2} alignment="center" frame={{ maxWidth: "infinity", height: 5, alignment: "center" }}>
      {Array.from({ length: segments }, (_, index) => (
        <HStack
          key={String(index)}
          frame={{ width: 13.7, height: 5 }}
          background={item.totalBytes <= 0 ? C.track : index < downCount ? C.down : C.up}
          clipShape="capsule"
        />
      ))}
    </HStack>
  )
}

function InterfaceDetail({ item }: { item: IfaceTraffic }) {
  const info = interfaceInfo(item.name)
  return (
    <VStack spacing={5} alignment="leading" frame={{ maxWidth: "infinity" }}>
      <HStack alignment="center" frame={{ maxWidth: "infinity" }}>
        <HStack spacing={7} alignment="center">
          <Image
            systemName={info.icon}
            resizable
            scaleToFit
            foregroundStyle={C.accent}
            frame={{ width: 15, height: 15 }}
          />
          <Text font={12} fontWeight="semibold" foregroundStyle={C.primary} lineLimit={1}>
            {info.title}
          </Text>
        </HStack>
        <Spacer />
        <Text font={12} fontWeight="bold" fontDesign="rounded" foregroundStyle={C.primary} lineLimit={1}>
          {formatDetailBytes(item.totalBytes, 1)}
        </Text>
      </HStack>
      <HStack spacing={0} alignment="center" frame={{ maxWidth: "infinity" }}>
        <DirectionValue direction="down" value={item.inBytes} />
        <DirectionValue direction="up" value={item.outBytes} />
      </HStack>
      <TrafficComposition item={item} />
    </VStack>
  )
}

function ErrorLine({ text }: { text: string }) {
  if (!text) return null
  return (
    <Text font={8} foregroundStyle={C.warn} lineLimit={1} padding={{ top: 2 }}>
      {text}
    </Text>
  )
}

function emptyDetail(props: WidgetViewProps): string {
  if (props.errorText) return props.errorText
  if (props.snapshot && props.snapshot.ts > 0) return "打开 Surge Panel 刷新一次数据"
  return "打开脚本填写 Surge HTTP API"
}

export function MediumView(props: WidgetViewProps) {
  const { snapshot, live, errorText, settings } = props
  if (!snapshot) {
    return (
      <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} widgetBackground={C.bg}>
        <EmptyState title="暂无数据" detail={emptyDetail(props)} />
      </ZStack>
    )
  }

  const blocks = metricBlocks(snapshot, settings)
  const bans = bansOf(snapshot)

  return (
    <VStack
      spacing={0}
      alignment="leading"
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      padding={{ horizontal: 14, top: 14, bottom: 8 }}
      widgetBackground={C.bg}
      widgetURL="scripting:///run/Surge%20Panel"
    >
      <Header fetchedAt={snapshot.dataAt} cached={!live} inset={8} titleFont={12} />

      <HStack spacing={8} alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 8 }}>
        <RateCard icon="arrow.down.circle.fill" label="累计下行" value={formatBytes(snapshot.totalIn)} color={C.down} />
        <HStack frame={{ width: 1, height: 43 }} background={C.track} />
        <RateCard icon="arrow.up.circle.fill" label="累计上行" value={formatBytes(snapshot.totalOut)} color={C.up} />
      </HStack>

      <HStack frame={{ maxWidth: "infinity", height: 1 }} background={C.track} />

      <HStack alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 6, bottom: 5 }}>
        {withSpacers(blocks)}
      </HStack>

      <HStack frame={{ maxWidth: "infinity", height: 1 }} background={C.track} />

      <HStack alignment="center" frame={{ maxWidth: "infinity" }} padding={{ horizontal: 8, top: 5 }}>
        {bans > 0 ? (
          <Text font={10} fontWeight="medium" foregroundStyle={C.warn}>
            未授权封禁 {bans}
          </Text>
        ) : (
          <Text font={10} fontWeight="medium" foregroundStyle={C.tertiary}>
            引擎累计 · 重启归零
          </Text>
        )}
        <Spacer />
        <VersionLabel value={labelOf(snapshot)} font={10} />
      </HStack>

      <ErrorLine text={live ? "" : errorText} />
    </VStack>
  )
}

export function LargeView(props: WidgetViewProps) {
  const { snapshot, live, errorText, settings } = props
  if (!snapshot) {
    return (
      <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} widgetBackground={C.bg}>
        <EmptyState title="暂无数据" detail={emptyDetail(props)} />
      </ZStack>
    )
  }

  const blocks = metricBlocks(snapshot, settings)
  const bans = bansOf(snapshot)
  const interfaces = settings.showInterfaces ? (snapshot.ifaces || []).slice(0, 3) : []
  return (
    <VStack
      spacing={0}
      alignment="leading"
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      padding={{ horizontal: 18, top: 18, bottom: 8 }}
      widgetBackground={C.bg}
      widgetURL="scripting:///run/Surge%20Panel"
    >
      <Header fetchedAt={snapshot.dataAt} cached={!live} inset={8} titleFont={12} />

      <HStack spacing={9} alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 10 }}>
        <RateCard icon="arrow.down.circle.fill" label="累计下行" value={formatBytes(snapshot.totalIn)} color={C.down} />
        <HStack frame={{ width: 1, height: 43 }} background={C.track} />
        <RateCard icon="arrow.up.circle.fill" label="累计上行" value={formatBytes(snapshot.totalOut)} color={C.up} />
      </HStack>

      <HStack alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 9, bottom: 8 }}>
        {withSpacers(blocks)}
      </HStack>

      {settings.showInterfaces ? (
        <>
          <Divider padding={{ horizontal: 8, top: 2 }} />

          <VStack spacing={8} alignment="leading" frame={{ maxWidth: "infinity" }} padding={{ horizontal: 8, top: 11 }}>
            {interfaces.length ? (
              interfaces.map((item) => <InterfaceDetail key={item.name} item={item} />)
            ) : (
              <Text font={11} foregroundStyle={C.secondary} padding={{ vertical: 12 }}>
                暂无接口流量
              </Text>
            )}
          </VStack>
        </>
      ) : null}

      {bans > 0 ? (
        <HStack spacing={5} alignment="center" padding={{ top: 7 }}>
          <Image
            systemName="exclamationmark.triangle.fill"
            foregroundStyle={C.warn}
            frame={{ width: 10, height: 10 }}
          />
          <Text font={9} fontWeight="semibold" foregroundStyle={C.warn}>
            未授权访问封禁 {bans}
          </Text>
        </HStack>
      ) : null}

      <Spacer />
      <HStack frame={{ maxWidth: "infinity" }} padding={{ top: 5, trailing: 8 }}>
        <Spacer />
        <VersionLabel value={labelOf(snapshot)} font={10} />
      </HStack>

      <ErrorLine text={live ? "" : errorText} />
    </VStack>
  )
}

/** 小尺寸：同一套配色与字号，纵向排布避免拥挤 */
export function SmallView(props: WidgetViewProps) {
  const { snapshot, live, errorText, settings } = props
  if (!snapshot) {
    return (
      <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} widgetBackground={C.bg}>
        <EmptyState title="暂无数据" detail={emptyDetail(props)} />
      </ZStack>
    )
  }

  const blocks = metricBlocks(snapshot, settings)

  return (
    <VStack
      spacing={0}
      alignment="leading"
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      padding={{ horizontal: 13, top: 13, bottom: 9 }}
      widgetBackground={C.bg}
      widgetURL="scripting:///run/Surge%20Panel"
    >
      <Header fetchedAt={snapshot.dataAt} cached={!live} inset={4} titleFont={11} />

      <HStack alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 4 }}>
        <RateCard icon="arrow.down.circle.fill" label="累计下行" value={formatBytes(snapshot.totalIn)} color={C.down} />
        <RateCard icon="arrow.up.circle.fill" label="累计上行" value={formatBytes(snapshot.totalOut)} color={C.up} />
      </HStack>

      <HStack frame={{ maxWidth: "infinity", height: 1 }} background={C.track} />

      <HStack alignment="center" frame={{ maxWidth: "infinity" }} padding={{ top: 5 }}>
        {blocks.slice(0, 2).map((b) => (
          <StatusBlock key={b.label} icon={b.icon} label={b.label} value={b.value} color={C.accent} />
        ))}
      </HStack>

      <Spacer />
      <HStack frame={{ maxWidth: "infinity" }} padding={{ horizontal: 4 }}>
        <Spacer />
        <VersionLabel value={labelOf(snapshot)} font={9} />
      </HStack>

      <ErrorLine text={live ? "" : errorText} />
    </VStack>
  )
}
