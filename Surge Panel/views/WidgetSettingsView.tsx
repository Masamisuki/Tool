// 小组件设置子页：样式、强调色、显示内容、家族预览
import { Button, HStack, List, Picker, Section, Spacer, Text, Toggle, Widget, useState } from "scripting"
import { LIST_STYLE, ListRow } from "../components/Kit"
import {
  WIDGET_ACCENTS,
  loadWidgetSettings,
  loadWidgetSnapshot,
  reloadWidgetsThrottled,
  saveWidgetSettings,
  type WidgetAccent,
  type WidgetSettings,
} from "../lib/widgetCache"
import { formatClock } from "../lib/metrics"

type Family = "systemSmall" | "systemMedium" | "systemLarge"

export function WidgetSettingsView() {
  const [settings, setSettings] = useState<WidgetSettings>(() => loadWidgetSettings())
  const [message, setMessage] = useState<string | null>(null)

  const snapshot = loadWidgetSnapshot()

  function update(partial: Partial<WidgetSettings>) {
    const next = saveWidgetSettings({ ...settings, ...partial })
    setSettings(next)
    // 立即让已经加到桌面的小组件按新设置重绘
    reloadWidgetsThrottled(true)
  }

  async function preview(family: Family) {
    try {
      Widget.reloadTestWidgets()
      await Widget.preview({ family })
      setMessage(null)
    } catch (e) {
      setMessage(`预览失败：${e}`)
    }
  }

  return (
    <List {...LIST_STYLE} navigationTitle="小组件" tabBarVisibility="visible">
      <Section
        header={<Text>外观</Text>}
        footer={<Text font={13}>紧凑只显示速率；详细会额外显示内存、运行时长、累计流量与速率曲线。改动会立即同步到桌面小组件。</Text>}
      >
        <Picker
          title="显示样式"
          value={settings.style}
          onChanged={(v: string) => update({ style: v === "compact" ? "compact" : "detailed" })}
        >
          <Text tag="compact">紧凑</Text>
          <Text tag="detailed">详细</Text>
        </Picker>
        <Picker title="强调色" value={settings.accent} onChanged={(v: string) => update({ accent: v as WidgetAccent })}>
          {WIDGET_ACCENTS.map((a) => (
            <Text key={a.tag} tag={a.tag}>
              {a.label}
            </Text>
          ))}
        </Picker>
      </Section>

      <Section header={<Text>显示内容</Text>}>
        <Toggle value={settings.showChart} onChanged={(v: boolean) => update({ showChart: v })}>
          <ListRow icon="chart.bar.fill" tone="teal" title="速率曲线" />
        </Toggle>
        <Toggle value={settings.showMemory} onChanged={(v: boolean) => update({ showMemory: v })}>
          <ListRow icon="memorychip.fill" tone="purple" title="内存占用" />
        </Toggle>
        <Toggle value={settings.showUptime} onChanged={(v: boolean) => update({ showUptime: v })}>
          <ListRow icon="clock.fill" tone="blue" title="运行时长" />
        </Toggle>
        <Toggle value={settings.showRequests} onChanged={(v: boolean) => update({ showRequests: v })}>
          <ListRow icon="bolt.fill" tone="orange" title="活动请求" />
        </Toggle>
        <Toggle value={settings.showTotals} onChanged={(v: boolean) => update({ showTotals: v })}>
          <ListRow icon="arrow.up.arrow.down.circle.fill" tone="green" title="累计流量" />
        </Toggle>
        <Toggle value={settings.showPeak} onChanged={(v: boolean) => update({ showPeak: v })}>
          <ListRow icon="gauge.with.dots.needle.67percent" tone="pink" title="峰值速率" />
        </Toggle>
      </Section>

      <Section
        header={<Text>预览</Text>}
        footer={
          <Text font={13}>
            预览会打开 Scripting 的小组件预览面板。请先运行一次 Surge Panel 让数据落盘，否则小组件显示「暂无数据」。
          </Text>
        }
      >
        <Button action={() => preview("systemSmall")}>
          <ListRow icon="square.grid.2x2.fill" tone="blue" title="小尺寸" titleColor="label" />
        </Button>
        <Button action={() => preview("systemMedium")}>
          <ListRow icon="square.grid.3x1.folder.fill.badge.plus" tone="teal" title="中尺寸" titleColor="label" />
        </Button>
        <Button action={() => preview("systemLarge")}>
          <ListRow icon="square.grid.3x3.fill" tone="purple" title="大尺寸" titleColor="label" />
        </Button>
      </Section>

      <Section header={<Text>数据</Text>} footer={message ? <Text font={13}>{message}</Text> : undefined}>
        <Button action={() => reloadWidgetsThrottled(true)}>
          <ListRow icon="arrow.clockwise" tone="green" title="立即刷新小组件" titleColor="label" />
        </Button>
        <HStack>
          <Text>实例</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{snapshot.instance || "—"}</Text>
        </HStack>
        <HStack>
          <Text>状态</Text>
          <Spacer />
          <Text foregroundStyle={snapshot.connected ? "systemGreen" : "secondaryLabel"}>
            {snapshot.connected ? "已同步" : "等待面板刷新"}
          </Text>
        </HStack>
        <HStack>
          <Text>最近取数</Text>
          <Spacer />
          <Text foregroundStyle="secondaryLabel">{snapshot.dataAt > 0 ? formatClock(snapshot.dataAt) : "—"}</Text>
        </HStack>
      </Section>
    </List>
  )
}
