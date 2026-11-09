// 小组件设置子页：显示内容与家族预览
import { Button, HStack, List, Section, Spacer, Text, Toggle, Widget, useState } from "scripting"
import { LIST_STYLE, ListRow } from "../components/Kit"
import {
  loadWidgetSettings,
  loadWidgetSnapshot,
  reloadWidgetsThrottled,
  saveWidgetSettings,
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
        header={<Text>显示内容</Text>}
        footer={<Text font={13}>中尺寸最多显示四个状态块；大尺寸还会列出各网卡累计流量。改动会立即同步到桌面小组件。</Text>}
      >
        <Toggle value={settings.showMemory} onChanged={(v: boolean) => update({ showMemory: v })}>
          <ListRow icon="memorychip.fill" tone="purple" title="内存占用" />
        </Toggle>
        <Toggle value={settings.showRequests} onChanged={(v: boolean) => update({ showRequests: v })}>
          <ListRow icon="bolt.fill" tone="orange" title="活动请求" />
        </Toggle>
        <Toggle value={settings.showDns} onChanged={(v: boolean) => update({ showDns: v })}>
          <ListRow icon="globe" tone="teal" title="DNS 缓存" />
        </Toggle>
        <Toggle value={settings.showUptime} onChanged={(v: boolean) => update({ showUptime: v })}>
          <ListRow icon="clock.fill" tone="blue" title="运行时长" />
        </Toggle>
        <Toggle value={settings.showInterfaces} onChanged={(v: boolean) => update({ showInterfaces: v })}>
          <ListRow icon="network" tone="green" title="网卡流量明细" />
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
