// 仪表盘 Tab：实例头、实时速率主卡、快捷开关、运行指标、内存趋势、最新事件
import {
  AreaChart,
  Button,
  Chart,
  Divider,
  gradient,
  HStack,
  Image,
  LineChart,
  Menu,
  NavigationStack,
  Script,
  ScrollView,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"
import { Card, HeroCard, IconBadge, MetricTile, PAGE_BG, SectionHeader, ValueText } from "../components/Kit"
import { ConnectionPill } from "../components/ConnectionStatus"
import { activeInstance, getState, needsSetup, openActivity, refreshNow, savePrefs, switchInstance, useStore } from "../lib/store"
import {
  evaluateScript,
  getDns,
  getEvents,
  getFeature,
  setFeature,
  FEATURE_LABELS,
  type FeatureKey,
  type SurgeConfig,
  type SurgeEvent,
} from "../lib/surgeApi"
import { InstancesView } from "./InstancesView"
import {
  buildInfo,
  collectRecordAddresses,
  countFakeIps,
  displayHostPort,
  displayPrimaryAddrs,
  downsample,
  formatBytesParts,
  formatClock,
  formatEventTime,
  formatSpeedParts,
  formatUptime,
  gaugeValue,
  parsePrimaryAddresses,
} from "../lib/metrics"
import { cardBackground, connectErrorText, IS_GLASS, METRICS_HINT, roundedShape, TONES, UI, type Tone } from "../lib/ui"
import { MemoryDiagView } from "./MemoryDiagView"

/** bytes/s → KB/s，一位小数 */
function toKbps(bytesPerSec: number): number {
  return Math.round((bytesPerSec ?? 0) / 102.4) / 10
}

/** Y 轴上界：1/2/5×10^n，并留约 15% 余量。速率不能为负，下界固定 0。 */
function niceUpper(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 10
  const padded = n * 1.15
  const mag = 10 ** Math.floor(Math.log10(padded))
  const norm = padded / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}

const LINE_STYLE = { lineWidth: 2.5, lineCap: "round" as const, lineJoin: "round" as const }

// 事件 / 功能开关 / Fake-IP 计数 / 本机地址变化很慢，不跟随每次采样刷新
const SLOW_REFRESH_MS = 30_000

const FEATURE_TILES: Record<FeatureKey, { icon: string; tone: Tone }> = {
  mitm: { icon: "lock.shield.fill", tone: "accent" },
  capture: { icon: "record.circle", tone: "red" },
  rewrite: { icon: "arrow.2.squarepath", tone: "orange" },
  scripting: { icon: "curlybraces", tone: "purple" },
}

export function DashboardView() {
  const state = useStore()
  const inst = activeInstance()
  const [showDiag, setShowDiag] = useState(false)
  const [showInst, setShowInst] = useState(false)
  const [events, setEvents] = useState<SurgeEvent[] | null>(null)
  const [features, setFeatures] = useState<Record<FeatureKey, boolean> | null>(null)
  const [fakeIpCount, setFakeIpCount] = useState<number | null>(null)
  const [localAddrs, setLocalAddrs] = useState<{ ipv4?: string; ipv6?: string }>({})

  const mem = state.samples ? gaugeValue(state.samples, "surge_memory_bytes") : null
  const uptime = state.samples ? gaugeValue(state.samples, "surge_uptime_seconds") : null
  const active = state.samples ? gaugeValue(state.samples, "surge_active_requests") : null
  const dns = state.samples ? gaugeValue(state.samples, "surge_dns_cache_entries") : null
  const bans = state.metricsAvailable === false ? null : state.samples ? gaugeValue(state.samples, "surge_active_bans") : null
  const info = state.metricsAvailable === false ? null : state.samples ? buildInfo(state.samples) : null
  const noMetrics = state.metricsAvailable === false
  const memParts = mem !== null ? formatBytesParts(mem) : null
  const downParts = state.running ? formatSpeedParts(state.speeds.inSpeed) : null
  const upParts = state.running ? formatSpeedParts(state.speeds.outSpeed) : null
  const peakIn = state.peakSpeeds.inSpeed
  const peakOut = state.peakSpeeds.outSpeed
  const isHome = Script.env === "home_screen"
  const setup = needsSetup()
  const version = info?.version ?? inst.version

  // 慢数据：事件、功能开关、DNS（只为 Fake-IP 计数）、$network 本机地址。
  // 这些请求不轻（getDns 是整份缓存），不跟随 5 秒采样，只在仪表盘可见时每 30 秒拉一轮。
  // 响应落地前校验 config 未变，避免切实例后旧响应覆盖新实例数据。
  function loadSlowData(cfg: SurgeConfig) {
    const fresh = () => getState().config === cfg
    getEvents(cfg)
      .then((r) => {
        if (fresh()) setEvents(r.events.slice().reverse())
      })
      .catch(() => {
        if (fresh()) setEvents(null)
      })
    Promise.all(
      (Object.keys(FEATURE_LABELS) as FeatureKey[]).map(async (k) => {
        const r = await getFeature(cfg, k)
        return [k, r.enabled] as const
      })
    )
      .then((pairs) => {
        if (fresh()) setFeatures(Object.fromEntries(pairs) as Record<FeatureKey, boolean>)
      })
      .catch(() => {
        if (fresh()) setFeatures(null)
      })
    getDns(cfg)
      .then((r) => {
        if (!fresh()) return
        const addrs = [
          ...collectRecordAddresses(r.local),
          ...collectRecordAddresses(r.dnsCache),
        ]
        setFakeIpCount(countFakeIps(addrs))
      })
      .catch(() => {
        if (fresh()) setFakeIpCount(null)
      })
    evaluateScript(cfg, "$done($network)", "generic", 3)
      .then((raw) => {
        if (fresh()) setLocalAddrs(parsePrimaryAddresses(raw))
      })
      .catch(() => {
        if (fresh()) setLocalAddrs({})
      })
  }

  const dashboardVisible = state.visibleTab === "dashboard"

  useEffect(() => {
    if (setup) {
      setEvents(null)
      setFeatures(null)
      setFakeIpCount(null)
      setLocalAddrs({})
      return
    }
    if (!dashboardVisible) return
    const cfg = state.config
    loadSlowData(cfg)
    const id = setInterval(() => loadSlowData(cfg), SLOW_REFRESH_MS)
    return () => clearInterval(id)
  }, [state.config, setup, dashboardVisible])

  async function toggleFeature(k: FeatureKey, v: boolean) {
    setFeatures((f) => (f ? { ...f, [k]: v } : f))
    try {
      await setFeature(state.config, k, v)
    } catch {
      try {
        const r = await getFeature(state.config, k)
        setFeatures((f) => (f ? { ...f, [k]: r.enabled } : f))
      } catch {
        // 保持乐观值
      }
    }
  }

  async function reload() {
    if (needsSetup()) return
    loadSlowData(state.config)
    await refreshNow().catch(() => {})
  }

  const chartPts = downsample(state.history, 60)
  const memValues = chartPts.map((p) => Math.round((p.mem / (1024 * 1024)) * 10) / 10)
  const memYMax = niceUpper(Math.max(0, ...memValues))
  const memMarks = chartPts.map((p, i) => ({
    label: new Date(p.t),
    value: memValues[i],
    // monotone 保单调、不过冲；catmullRom 会在尖峰前插出负值
    interpolationMethod: "monotone" as const,
    foregroundStyle: gradient("linear", {
      colors: ["rgba(175,82,222,0.45)", "rgba(175,82,222,0.02)"],
      startPoint: "top" as const,
      endPoint: "bottom" as const,
    }),
  }))

  // 实时速率双线（KB/s）：foregroundStyleBy 是官方的多序列写法；
  // 两个 LineChart 子组件会被串成一条折线（实测出现连接线伪影），必须用单 LineChart + 序列编码
  const speedMarks = state.speedHistory.flatMap((p) => [
    {
      label: new Date(p.t),
      value: toKbps(p.inSpeed),
      interpolationMethod: "monotone" as const,
      lineStyle: LINE_STYLE,
      foregroundStyleBy: { value: "下载", label: "下载" },
    },
    {
      label: new Date(p.t),
      value: toKbps(p.outSpeed),
      interpolationMethod: "monotone" as const,
      lineStyle: LINE_STYLE,
      foregroundStyleBy: { value: "上传", label: "上传" },
    },
  ])
  const speedYMax = niceUpper(
    Math.max(0, ...state.speedHistory.flatMap((p) => [toKbps(p.inSpeed), toKbps(p.outSpeed)]))
  )

  const latestEvent = events && events.length > 0 ? events[0] : null
  const hideAddresses = state.prefs.hideAddresses
  const endpointText = displayHostPort(inst.host, inst.port, hideAddresses)
  const localAddrText = displayPrimaryAddrs(localAddrs, hideAddresses)
  const activityBadge =
    state.failedRecent > 0 || state.rejectedRecent > 0
      ? `失败 ${state.failedRecent} · 拒绝 ${state.rejectedRecent}`
      : undefined
  const dnsParts: string[] = []
  if (fakeIpCount != null && fakeIpCount > 0) dnsParts.push(`Fake-IP ${fakeIpCount}`)
  if (bans !== null) dnsParts.push(`封禁 ${bans}`)
  const dnsSubtitle = dnsParts.length > 0 ? dnsParts.join(" · ") : "缓存条目"

  return (
    <ScrollView
      axes="vertical"
      refreshable={reload}
      background={PAGE_BG}
      sheet={{
        isPresented: showDiag || showInst,
        onChanged: (v: boolean) => {
          if (!v) {
            setShowDiag(false)
            setShowInst(false)
          }
        },
        content: showDiag ? (
          <MemoryDiagView />
        ) : (
          <NavigationStack>
            <InstancesView
              startAdding={setup && state.instances.length === 0}
              onClose={() => setShowInst(false)}
            />
          </NavigationStack>
        ),
      }}
    >
      <VStack alignment="leading" spacing={UI.pageSpacing} padding={{ horizontal: UI.pagePadding, top: isHome ? 8 : 4, bottom: 28 }}>
        {/* 实例头：名称可切换，地址行可隐藏 */}
        <HStack alignment="top" spacing={10}>
          <VStack alignment="leading" spacing={6}>
            {setup || state.instances.length === 0 ? (
              <Button buttonStyle="plain" action={() => setShowInst(true)}>
                <InstanceTitle name={inst.name} isHome={isHome} />
              </Button>
            ) : (
              // 原生菜单直接切换：首页 Tab 里不弹 sheet，也不和翻页手势抢点击
              <Menu label={<InstanceTitle name={inst.name} isHome={isHome} />}>
                {state.instances.map((i) => (
                  <Button
                    key={i.id}
                    title={i.name}
                    systemImage={i.id === state.activeId ? "checkmark" : "server.rack"}
                    action={() => { void switchInstance(i.id) }}
                  />
                ))}
                <Divider />
                <Button title="管理实例…" systemImage="slider.horizontal.3" action={() => setShowInst(true)} />
              </Menu>
            )}
            <HStack
              spacing={6}
              onTapGesture={setup ? undefined : () => savePrefs({ ...state.prefs, hideAddresses: !hideAddresses })}
            >
              <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>
                {setup
                  ? "点按名称添加 Surge HTTP API 实例"
                  : [
                      version ? `Surge ${version}` : null,
                      state.updatedAt ? `更新于 ${formatClock(state.updatedAt)}` : "正在连接…",
                      endpointText,
                      localAddrText || null,
                    ].filter(Boolean).join(" · ")}
              </Text>
              {setup ? null : (
                <Image systemName={hideAddresses ? "eye.slash" : "eye"} font={11} foregroundStyle="tertiaryLabel" />
              )}
            </HStack>
          </VStack>
          <Spacer />
          {isHome ? null : <ConnectionPill />}
        </HStack>

        {setup ? (
          <Card tone="accent" spacing={10}>
            <HStack spacing={12}>
              <IconBadge icon="sparkles" tone="accent" size={38} filled />
              <VStack alignment="leading" spacing={2}>
                <Text font={UI.titleFont} fontWeight="semibold">开始使用</Text>
                <Text font={13} foregroundStyle="secondaryLabel">添加实例并填写 Key 后才会拉取数据</Text>
              </VStack>
            </HStack>
            <Text font={13} foregroundStyle="secondaryLabel">
              本机默认用 HTTP。局域网连接只应在可信网络使用；HTTPS 需安装并信任 Surge MITM CA。
            </Text>
            <Button
              title={state.instances.length === 0 ? "添加实例" : "去完善实例"}
              systemImage="plus"
              buttonStyle={IS_GLASS ? "glassProminent" : "borderedProminent"}
              tint={TONES.accent.fg}
              action={() => setShowInst(true)}
            />
          </Card>
        ) : null}

        {!setup && state.error ? (
          <Card tone="red" spacing={6}>
            <HStack spacing={8}>
              <Image systemName="exclamationmark.triangle.fill" foregroundStyle={TONES.red.fg} font={15} />
              <Text font={15} fontWeight="semibold" foregroundStyle={TONES.red.fg}>连接异常</Text>
            </HStack>
            <Text font={13} foregroundStyle="secondaryLabel">
              {connectErrorText(state.error, "错误", state.errorKind)}
            </Text>
          </Card>
        ) : null}

        {!setup ? (
          <>
            {/* 实时速率主卡：点按进入活动 → 流量 */}
            <HeroCard onTap={() => openActivity("traffic")}>
              <HStack>
                <Text font={13} fontWeight="semibold" foregroundStyle="rgba(255,255,255,0.85)">实时速率</Text>
                <Spacer />
                <Text font={11} foregroundStyle="rgba(255,255,255,0.7)">1 秒采样 · 近 1 分钟</Text>
                <Image systemName="chevron.right" font={10} foregroundStyle="rgba(255,255,255,0.7)" />
              </HStack>
              <HStack spacing={12} alignment="top">
                <SpeedColumn
                  icon="arrow.down.circle.fill"
                  label="下载"
                  parts={downParts}
                  peak={peakIn > 0 ? formatSpeedParts(peakIn) : null}
                />
                <SpeedColumn
                  icon="arrow.up.circle.fill"
                  label="上传"
                  parts={upParts}
                  peak={peakOut > 0 ? formatSpeedParts(peakOut) : null}
                />
              </HStack>
              {state.traffic && speedMarks.length >= 4 ? (
                <Chart
                  frame={{ height: 84 }}
                  chartYScale={{ domain: { from: 0, to: speedYMax }, type: "linear" }}
                  chartXAxis="hidden"
                  chartYAxis="hidden"
                  chartLegend="hidden"
                  chartForegroundStyleScale={{
                    "下载": "white",
                    "上传": "rgba(160,235,255,0.9)",
                  }}
                >
                  <LineChart marks={speedMarks} />
                </Chart>
              ) : (
                <Text font={12} foregroundStyle="rgba(255,255,255,0.7)" frame={{ height: 84 }}>
                  采样中，稍后展示速率曲线…
                </Text>
              )}
            </HeroCard>

            {/* 快捷开关 */}
            {features ? (
              <VStack alignment="leading" spacing={10}>
                <SectionHeader title="快捷开关" caption="立即写入当前实例" />
                <HStack spacing={10}>
                  {(Object.keys(FEATURE_LABELS) as FeatureKey[]).map((k) => (
                    <FeatureTile
                      key={k}
                      label={FEATURE_LABELS[k]}
                      icon={FEATURE_TILES[k].icon}
                      tone={FEATURE_TILES[k].tone}
                      on={features[k]}
                      onToggle={() => toggleFeature(k, !features[k])}
                    />
                  ))}
                </HStack>
              </VStack>
            ) : null}

            {/* 运行指标 */}
            <VStack alignment="leading" spacing={10}>
              <SectionHeader title="运行状态" caption={info ? `Build ${info.build}` : undefined} />
              <HStack spacing={10}>
                <MetricTile
                  icon="memorychip"
                  tone="purple"
                  title="内存"
                  value={memParts ? memParts.value : "—"}
                  unit={memParts?.unit}
                  subtitle={noMetrics ? "需 iOS 5.22+ / Mac 6.9+" : "查看诊断"}
                  onTap={() => setShowDiag(true)}
                />
                <MetricTile
                  icon="clock"
                  tone="green"
                  title="运行时长"
                  value={uptime !== null ? formatUptime(uptime) : "—"}
                  subtitle={version ? `Surge ${version}` : undefined}
                />
              </HStack>
              <HStack spacing={10}>
                <MetricTile
                  icon="link"
                  tone="orange"
                  title="活动连接"
                  value={active !== null ? String(active) : "—"}
                  badge={activityBadge}
                  subtitle="HTTP 请求"
                  onTap={() => openActivity("connections", "active")}
                />
                <MetricTile
                  icon="server.rack"
                  tone="teal"
                  title="DNS 缓存"
                  value={dns !== null ? String(dns) : "—"}
                  subtitle={dnsSubtitle}
                  onTap={() => openActivity("dns")}
                />
              </HStack>
            </VStack>

            {/* 内存趋势 */}
            <Card>
              <SectionHeader
                title="内存趋势"
                actionTitle={noMetrics ? undefined : "诊断"}
                onAction={noMetrics ? undefined : () => setShowDiag(true)}
                caption={noMetrics ? "无 /metrics" : undefined}
              />
              {noMetrics ? (
                <Text font={13} foregroundStyle="secondaryLabel">{METRICS_HINT}</Text>
              ) : memMarks.length >= 2 ? (
                <Chart
                  frame={{ height: 120 }}
                  chartYScale={{ domain: { from: 0, to: memYMax }, type: "linear" }}
                  chartXAxis={{ valueLabel: { format: "time" } }}
                >
                  <AreaChart marks={memMarks} />
                </Chart>
              ) : (
                <Text font={13} foregroundStyle="secondaryLabel">采样中，稍后展示趋势…</Text>
              )}
              {!noMetrics ? (
                <Text font={11} foregroundStyle="tertiaryLabel">{`${state.history.length} 个采样点 · MB`}</Text>
              ) : null}
            </Card>

            {/* 最新事件：点按进入活动 → 事件 */}
            <HStack
              spacing={12}
              padding={14}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
              background={cardBackground(UI.tileRadius)}
              contentShape={roundedShape(UI.tileRadius)}
              onTapGesture={() => openActivity("events")}
            >
              <IconBadge icon={latestEvent ? "bell.badge.fill" : "bell"} tone={latestEvent ? "orange" : "gray"} size={34} />
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={15} fontWeight="semibold">
                  {events === null ? "事件" : events.length === 0 ? "暂无事件" : `${events.length} 条事件`}
                </Text>
                <Text font={UI.captionFont} foregroundStyle="secondaryLabel" lineLimit={2}>
                  {latestEvent
                    ? `${formatEventTime(latestEvent.date)} · ${latestEvent.content ?? latestEvent.identifier}`
                    : "打开事件中心"}
                </Text>
              </VStack>
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" font={12} />
            </HStack>
          </>
        ) : null}
      </VStack>
    </ScrollView>
  )
}

/** 实例名 + 下拉箭头；整块（含行高）都可点按 */
function InstanceTitle({ name, isHome }: { name: string; isHome: boolean }) {
  return (
    <HStack spacing={6} padding={{ vertical: 4 }} frame={{ minHeight: 44 }} contentShape="rect">
      <Text font={isHome ? 26 : 32} fontWeight="bold" fontDesign="rounded" foregroundStyle="label" lineLimit={1} minScaleFactor={0.6}>
        {name}
      </Text>
      <Image systemName="chevron.down.circle.fill" font={17} symbolRenderingMode="hierarchical" foregroundStyle="secondaryLabel" />
    </HStack>
  )
}

function SpeedColumn({
  icon,
  label,
  parts,
  peak,
}: {
  icon: string
  label: string
  parts: { value: string; unit: string } | null
  peak: { value: string; unit: string } | null
}) {
  return (
    <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={5}>
        <Image systemName={icon} font={13} foregroundStyle="rgba(255,255,255,0.9)" />
        <Text font={13} fontWeight="medium" foregroundStyle="rgba(255,255,255,0.9)">{label}</Text>
      </HStack>
      <ValueText
        value={parts ? parts.value : "—"}
        unit={parts?.unit}
        size={UI.heroFont}
        color="white"
        unitColor="rgba(255,255,255,0.75)"
      />
      <Text font={11} foregroundStyle="rgba(255,255,255,0.7)" lineLimit={1}>
        {peak ? `峰值 ${peak.value} ${peak.unit}` : "全部网络接口"}
      </Text>
    </VStack>
  )
}

function FeatureTile({
  label,
  icon,
  tone,
  on,
  onToggle,
}: {
  label: string
  icon: string
  tone: Tone
  on: boolean
  onToggle: () => void
}) {
  return (
    <VStack
      spacing={8}
      padding={{ vertical: 12, horizontal: 4 }}
      frame={{ maxWidth: "infinity" }}
      background={cardBackground(UI.tileRadius, on ? TONES[tone].soft : UI.cardBg)}
      contentShape={roundedShape(UI.tileRadius)}
      onTapGesture={onToggle}
      accessibilityLabel={`${label}：${on ? "已开启" : "已关闭"}`}
    >
      <IconBadge icon={icon} tone={on ? tone : "gray"} size={34} filled={on} />
      <Text font={13} fontWeight="semibold" lineLimit={1} minScaleFactor={0.7}>{label}</Text>
      <Text font={11} fontWeight="medium" foregroundStyle={on ? TONES[tone].fg : "tertiaryLabel"}>
        {on ? "已开启" : "已关闭"}
      </Text>
    </VStack>
  )
}
