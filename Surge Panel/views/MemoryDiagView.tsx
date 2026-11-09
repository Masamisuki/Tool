// 内存诊断 sheet：趋势图 + 窗口统计 + 判断；事件请到「活动 → 事件」
import {
  AreaChart,
  Button,
  Chart,
  gradient,
  HStack,
  LineChart,
  Navigation,
  NavigationStack,
  Picker,
  ScrollView,
  Text,
  useState,
  VStack,
} from "scripting"
import { Card, IconBadge, PAGE_BG, SectionHeader, Tag, ValueText } from "../components/Kit"
import { openActivity, savePrefs, useStore } from "../lib/store"
import { reloadProfile } from "../lib/surgeApi"
import {
  analyzeMemoryTrend,
  downsample,
  formatBytes,
  formatMemSlope,
  gaugeValue,
  historyForRange,
  MEM_RANGE_OPTIONS,
  type MemRangeMin,
} from "../lib/metrics"
import { IS_GLASS, METRICS_HINT, UI, type Tone } from "../lib/ui"

export function MemoryDiagView() {
  const state = useStore()
  const dismiss = Navigation.useDismiss()
  const [confirmReload, setConfirmReload] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const rangeMin = (MEM_RANGE_OPTIONS.some((o) => o.minutes === state.prefs.memRangeMin)
    ? state.prefs.memRangeMin
    : 60) as MemRangeMin
  const rangeMs = rangeMin * 60 * 1000
  const windowPts = historyForRange(state.history, state.memLong, rangeMs)
  const trend = analyzeMemoryTrend(windowPts, {
    recentMs: Math.min(20 * 60 * 1000, rangeMs),
    intervalSec: state.prefs.intervalSec,
  })
  const mem = state.samples ? gaugeValue(state.samples, "surge_memory_bytes") : null
  const currentMB = mem !== null ? mem / (1024 * 1024) : trend.currentMB

  const pts = downsample(windowPts, 80)
  const marks = pts.map((p) => ({
    label: new Date(p.t),
    value: Math.round((p.mem / (1024 * 1024)) * 10) / 10,
    interpolationMethod: "monotone" as const,
  }))
  const memYMax = Math.max(10, Math.max(0, ...marks.map((m) => m.value)) * 1.15)

  const verdict: { icon: string; tone: Tone; title: string } =
    trend.level === "warning"
      ? { icon: "exclamationmark.triangle.fill", tone: "orange", title: "检测到异常趋势" }
      : trend.level === "ok"
        ? { icon: "checkmark.seal.fill", tone: "green", title: "运行正常" }
        : { icon: "hourglass", tone: "gray", title: "数据不足" }

  const currentText = currentMB > 0 ? currentMB.toFixed(1) : mem !== null ? formatBytes(mem) : "—"
  const currentUnit = currentMB > 0 ? "MB" : undefined

  function showEvents() {
    dismiss()
    openActivity("events")
  }

  async function doReload() {
    try {
      await reloadProfile(state.config)
      setActionMsg("配置已重新加载")
    } catch (e) {
      setActionMsg(`重载失败：${String(e)}`)
    }
  }

  return (
    <NavigationStack>
      <ScrollView
        axes="vertical"
        navigationTitle="内存诊断"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        toolbar={{ confirmationAction: <Button title="完成" action={dismiss} /> }}
        confirmationDialog={{
          isPresented: confirmReload,
          onChanged: setConfirmReload,
          title: "重新加载配置？",
          actions: <Button title="重新加载" action={doReload} />,
        }}
      >
        <VStack alignment="leading" spacing={UI.pageSpacing} padding={UI.pagePadding}>
          {state.metricsAvailable === false ? (
            <Card tone="orange">
              <HStack spacing={10}>
                <IconBadge icon="chart.line.downtrend.xyaxis" tone="orange" />
                <Text font={UI.titleFont} fontWeight="semibold">当前版本没有内存指标</Text>
              </HStack>
              <Text font={13} foregroundStyle="secondaryLabel">{METRICS_HINT}</Text>
              <Text font={13} foregroundStyle="secondaryLabel">
                Prometheus /metrics 需 Surge iOS 5.22+ 或 Mac 6.9+。没有该端点时，流量、策略、请求仍可用。
              </Text>
              <Button title="查看事件" systemImage="bell" buttonStyle="bordered" action={showEvents} />
            </Card>
          ) : (
            <>
              <Card tone={verdict.tone}>
                <HStack spacing={12}>
                  <IconBadge icon={verdict.icon} tone={verdict.tone} size={40} filled />
                  <VStack alignment="leading" spacing={2}>
                    <Text font={UI.titleFont} fontWeight="semibold">{verdict.title}</Text>
                    <Text font={UI.captionFont} foregroundStyle="secondaryLabel">
                      {trend.historyMin > 0
                        ? `已有 ${trend.historyMin >= 60 ? `${(trend.historyMin / 60).toFixed(1)} 小时` : `${Math.max(1, Math.round(trend.historyMin))} 分钟`} · ${trend.samples} 点`
                        : "采样中"}
                    </Text>
                  </VStack>
                </HStack>
                <Text font={13} foregroundStyle="secondaryLabel">{trend.message}</Text>
                <HStack spacing={10}>
                  {trend.level === "warning" ? (
                    <Button
                      title="重新加载配置"
                      systemImage="arrow.triangle.2.circlepath"
                      buttonStyle={IS_GLASS ? "glassProminent" : "borderedProminent"}
                      action={() => setConfirmReload(true)}
                    />
                  ) : null}
                  <Button title="查看事件" systemImage="bell" buttonStyle="bordered" action={showEvents} />
                </HStack>
                {actionMsg ? <Text font={12} foregroundStyle="secondaryLabel">{actionMsg}</Text> : null}
              </Card>

              <Card>
                <VStack alignment="leading" spacing={2}>
                  <Text font={13} fontWeight="medium" foregroundStyle="secondaryLabel">当前占用</Text>
                  <ValueText value={currentText} unit={currentUnit} size={UI.heroFont} />
                </VStack>
                <Picker
                  title="查看范围"
                  pickerStyle="segmented"
                  value={String(rangeMin)}
                  onChanged={(v: string) =>
                    savePrefs({ ...state.prefs, memRangeMin: Number(v) as MemRangeMin })
                  }
                >
                  {MEM_RANGE_OPTIONS.map((o) => (
                    <Text key={o.tag} tag={o.tag}>{o.label}</Text>
                  ))}
                </Picker>
                {marks.length >= 2 ? (
                  <Chart
                    frame={{ height: 190 }}
                    chartYScale={{ domain: { from: 0, to: memYMax }, type: "linear" }}
                    chartXAxis={{ valueLabel: { format: "time" } }}
                  >
                    <LineChart marks={marks.map((m) => ({ ...m, foregroundStyle: "systemPurple" as const }))} />
                    <AreaChart
                      marks={marks.map((m) => ({
                        ...m,
                        foregroundStyle: gradient("linear", {
                          colors: ["rgba(175,82,222,0.32)", "rgba(175,82,222,0.02)"],
                          startPoint: "top" as const,
                          endPoint: "bottom" as const,
                        }),
                      }))}
                    />
                  </Chart>
                ) : (
                  <Text font={13} foregroundStyle="secondaryLabel">采样数据不足…</Text>
                )}
              </Card>

              <VStack alignment="leading" spacing={10}>
                <SectionHeader title="窗口统计" caption={`${MEM_RANGE_OPTIONS.find((o) => o.minutes === rangeMin)?.label ?? ""}`} />
                <HStack spacing={10}>
                  <DiagItem label="峰值" value={trend.peakMB > 0 ? trend.peakMB.toFixed(1) : "—"} unit={trend.peakMB > 0 ? "MB" : undefined} />
                  <DiagItem label="谷值" value={trend.minMB > 0 ? trend.minMB.toFixed(1) : "—"} unit={trend.minMB > 0 ? "MB" : undefined} />
                  <DiagItem
                    label="振幅"
                    value={trend.rangeMB > 0 ? trend.rangeMB.toFixed(1) : trend.samples >= 12 ? "≈ 0" : "—"}
                    unit={trend.rangeMB > 0 ? "MB" : undefined}
                  />
                </HStack>
                <HStack spacing={10}>
                  <DiagItem
                    label="变化速率"
                    value={trend.samples >= 12 ? formatMemSlope(trend.slopeMBPerMin) : "—"}
                    tag={trend.level === "warning" ? "偏高" : undefined}
                  />
                  <DiagItem
                    label="速率窗口"
                    value={trend.windowMin > 0 ? String(Math.max(1, Math.round(trend.windowMin))) : "—"}
                    unit={trend.windowMin > 0 ? "分钟" : undefined}
                  />
                </HStack>
              </VStack>
            </>
          )}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

function DiagItem({ label, value, unit, tag }: { label: string; value: string; unit?: string; tag?: string }) {
  return (
    <Card padding={12} spacing={6}>
      <HStack spacing={6}>
        <Text font={12} fontWeight="medium" foregroundStyle="secondaryLabel">{label}</Text>
        {tag ? <Tag text={tag} tone="orange" /> : null}
      </HStack>
      <ValueText value={value} unit={unit} size={19} />
    </Card>
  )
}
