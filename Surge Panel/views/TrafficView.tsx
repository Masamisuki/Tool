// 活动 → 流量：网卡 interface 与节点 connector 分层，排行取 /v1/traffic 累计
import {
  HStack,
  Image,
  Picker,
  ScrollView,
  Spacer,
  Text,
  useState,
  VStack,
  type Color,
} from "scripting"
import { GradientBar } from "../components/GradientBar"
import { Card, EmptyState, IconBadge, MetricTile, PAGE_BG, SectionHeader } from "../components/Kit"
import { ActivityChips } from "../components/SegmentChips"
import { refreshNow, useStore } from "../lib/store"
import { formatBytes, formatSpeed, formatSpeedParts, ifaceDisplayName, isDirectPolicy } from "../lib/metrics"
import { DOWN_TONE, TONES, UI, UP_TONE } from "../lib/ui"
import type { TrafficEntry } from "../lib/surgeApi"

const BAR_COLORS: [Color, Color][] = [
  ["#5E5CE6", "#64D2FF"],
  ["#0A84FF", "#64D2FF"],
  ["#30B0C7", "#63E6BE"],
  ["#AF52DE", "#5E5CE6"],
  ["#FF9F0A", "#FFD60A"],
]

type SortKey = "current" | "total" | "peak"

function sortedEntries(
  rec: Record<string, TrafficEntry> | undefined,
  by: SortKey
): [string, TrafficEntry][] {
  if (!rec) return []
  return Object.entries(rec).sort((a, b) => {
    const score = (e: TrafficEntry) =>
      by === "current"
        ? e.inCurrentSpeed + e.outCurrentSpeed
        : by === "peak"
          ? e.inMaxSpeed + e.outMaxSpeed
          : e.in + e.out
    return score(b[1]) - score(a[1])
  })
}

function ifaceIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.startsWith("lo")) return "arrow.triangle.2.circlepath"
  if (n.startsWith("pdp") || n.includes("cell")) return "antenna.radiowaves.left.and.right"
  if (n.startsWith("en") || n.includes("wi")) return "wifi"
  if (n.startsWith("utun") || n.startsWith("ipsec")) return "lock.shield"
  return "network"
}

function SpeedPair({ down, up }: { down: number; up: number }) {
  return (
    <VStack alignment="trailing" spacing={2}>
      <HStack spacing={4}>
        <Image systemName="arrow.down" font={10} foregroundStyle={TONES[DOWN_TONE].fg} />
        <Text font={13} fontDesign="rounded" monospacedDigit>{formatSpeed(down)}</Text>
      </HStack>
      <HStack spacing={4}>
        <Image systemName="arrow.up" font={10} foregroundStyle={TONES[UP_TONE].fg} />
        <Text font={13} fontDesign="rounded" monospacedDigit foregroundStyle="secondaryLabel">{formatSpeed(up)}</Text>
      </HStack>
    </VStack>
  )
}

export function TrafficView() {
  const state = useStore()
  const [sortBy, setSortBy] = useState<SortKey>("current")

  const interfaces = sortedEntries(state.traffic?.interface, sortBy)
  const connectors = sortedEntries(state.traffic?.connector, sortBy)
  const activeNodes = connectors.filter(
    ([, v]) => v.inCurrentSpeed + v.outCurrentSpeed > 0
  )
  const ranked = sortedEntries(state.traffic?.connector, "total")
    .map(([name, v]) => ({ name, total: v.in + v.out }))
    .filter((r) => r.total > 0)
    .slice(0, 10)
  const maxTotal = ranked.length > 0 ? ranked[0].total : 1

  const downParts = state.running ? formatSpeedParts(state.speeds.inSpeed) : null
  const upParts = state.running ? formatSpeedParts(state.speeds.outSpeed) : null

  let directBytes = 0
  let proxyBytes = 0
  for (const [name, v] of connectors) {
    const total = v.in + v.out
    if (isDirectPolicy(name)) directBytes += total
    else proxyBytes += total
  }
  const splitTotal = directBytes + proxyBytes
  const directRatio = splitTotal > 0 ? directBytes / splitTotal : 0
  const directPct = Math.round(directRatio * 100)
  const proxyPct = splitTotal > 0 ? 100 - directPct : 0

  return (
    <ScrollView axes="vertical" refreshable={async () => { await refreshNow() }} background={PAGE_BG}>
      <VStack alignment="leading" spacing={UI.pageSpacing} padding={{ horizontal: UI.pagePadding, top: 8, bottom: 28 }}>
        <ActivityChips />

        <HStack spacing={10}>
          <MetricTile
            icon="arrow.down"
            tone={DOWN_TONE}
            title="实时下载"
            value={downParts ? downParts.value : "—"}
            unit={downParts?.unit}
            subtitle="全部网络接口"
          />
          <MetricTile
            icon="arrow.up"
            tone={UP_TONE}
            title="实时上传"
            value={upParts ? upParts.value : "—"}
            unit={upParts?.unit}
            subtitle="全部网络接口"
          />
        </HStack>

        {state.traffic ? (
          <Card>
            <SectionHeader title="本次运行分流" caption={formatBytes(splitTotal)} />
            <SplitBar ratio={directRatio} empty={splitTotal === 0} />
            <HStack spacing={16}>
              <SplitLegend color={TONES.green.fg} label="直连" bytes={directBytes} pct={directPct} />
              <SplitLegend color={TONES.accent.fg} label="代理" bytes={proxyBytes} pct={proxyPct} />
            </HStack>
          </Card>
        ) : null}

        <Picker title="明细排序" pickerStyle="segmented" value={sortBy} onChanged={(v: string) => setSortBy(v as SortKey)}>
          <Text tag="current">实时</Text>
          <Text tag="total">累计</Text>
          <Text tag="peak">峰值</Text>
        </Picker>

        <Card spacing={14}>
          <SectionHeader title="网卡" caption={state.traffic ? `${interfaces.length} 个接口` : "未连接"} />
          {interfaces.length === 0 ? (
            <EmptyState icon="network.slash" title="暂无接口数据" />
          ) : (
            interfaces.map(([name, v]) => {
              const ifaceLabel = ifaceDisplayName(name)
              return (
                <HStack key={name} spacing={12}>
                  <IconBadge icon={ifaceIcon(name)} tone="blue" size={32} />
                  <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    <HStack spacing={6}>
                      <Text font={15} fontWeight="semibold" lineLimit={1}>{ifaceLabel || name}</Text>
                      {ifaceLabel ? <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">{name}</Text> : null}
                    </HStack>
                    <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.7}>
                      {`累计 ↓${formatBytes(v.in)} ↑${formatBytes(v.out)} · 峰值 ↓${formatSpeed(v.inMaxSpeed)}`}
                    </Text>
                  </VStack>
                  <SpeedPair down={v.inCurrentSpeed} up={v.outCurrentSpeed} />
                </HStack>
              )
            })
          )}
        </Card>

        <Card spacing={14}>
          <SectionHeader title="活动中的节点" caption={state.traffic ? `${activeNodes.length} 个正在传输` : "未连接"} />
          {activeNodes.length === 0 ? (
            <EmptyState icon="pause.circle" title="当前没有节点在传输" />
          ) : (
            activeNodes.map(([name, v]) => (
              <HStack key={name} spacing={12}>
                <IconBadge icon={isDirectPolicy(name) ? "arrow.right" : "globe"} tone={isDirectPolicy(name) ? "green" : "accent"} size={32} />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={15} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>{name}</Text>
                  <Text font={11} foregroundStyle="tertiaryLabel">{`累计 ${formatBytes(v.in + v.out)}`}</Text>
                </VStack>
                <SpeedPair down={v.inCurrentSpeed} up={v.outCurrentSpeed} />
              </HStack>
            ))
          )}
        </Card>

        <Card spacing={14}>
          <SectionHeader title="节点流量排行" caption="本次引擎运行累计" />
          {ranked.length === 0 ? (
            <EmptyState icon="chart.bar" title="暂无流量数据" />
          ) : (
            ranked.map((r, i) => (
              <GradientBar
                key={r.name}
                rank={i + 1}
                label={r.name}
                valueText={formatBytes(r.total)}
                ratio={r.total / maxTotal}
                colors={BAR_COLORS[i % BAR_COLORS.length]}
              />
            ))
          )}
        </Card>
      </VStack>
    </ScrollView>
  )
}

function SplitBar({ ratio, empty }: { ratio: number; empty: boolean }) {
  return (
    <GradientBar
      ratio={empty ? 0 : ratio}
      colors={[TONES.green.fg, TONES.green.fg]}
      track={empty ? "rgba(142,142,147,0.22)" : TONES.accent.fg}
      height={12}
    />
  )
}

function SplitLegend({ color, label, bytes, pct }: { color: Color; label: string; bytes: number; pct: number }) {
  return (
    <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={5}>
        <Image systemName="circle.fill" font={8} foregroundStyle={color} />
        <Text font={12} foregroundStyle="secondaryLabel">{label}</Text>
        <Spacer />
        <Text font={12} fontWeight="semibold" fontDesign="rounded" monospacedDigit foregroundStyle="secondaryLabel">{`${pct}%`}</Text>
      </HStack>
      <Text font={17} fontWeight="semibold" fontDesign="rounded" monospacedDigit>{formatBytes(bytes)}</Text>
    </VStack>
  )
}
