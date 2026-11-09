// 活动 → 事件中心
import { HStack, List, Section, Text, useState, VStack } from "scripting"
import { getEvents, type SurgeEvent } from "../lib/surgeApi"
import { formatEventTime } from "../lib/metrics"
import { useStoreSelector } from "../lib/store"
import { useTabAutoRefresh } from "../lib/liveCache"
import { connectErrorText, type Tone } from "../lib/ui"
import { BARE_ROW, EmptyState, IconBadge, LIST_STYLE } from "../components/Kit"
import { ActivityChips } from "../components/SegmentChips"
import { listTitle } from "./ConnectionsView"

// 事件 identifier 形如 "reload-profile" / "network-changed"，按关键字挑图标
function eventVisual(e: SurgeEvent): { icon: string; tone: Tone } {
  const id = `${e.identifier} ${e.content ?? ""}`.toLowerCase()
  if (/error|fail|错误|失败/.test(id)) return { icon: "exclamationmark.triangle.fill", tone: "red" }
  if (/network|wifi|cellular|网络/.test(id)) return { icon: "wifi", tone: "blue" }
  if (/profile|reload|配置/.test(id)) return { icon: "doc.badge.gearshape", tone: "accent" }
  if (/policy|proxy|策略/.test(id)) return { icon: "arrow.triangle.branch", tone: "teal" }
  if (/memory|内存/.test(id)) return { icon: "memorychip", tone: "purple" }
  return { icon: "bell.fill", tone: "orange" }
}

export function EventsView() {
  const config = useStoreSelector((s) => s.config)
  const [events, setEvents] = useState<SurgeEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const r = await getEvents(config)
      setEvents(r.events.slice().reverse())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useTabAutoRefresh("activity", load)

  return (
    <List
      navigationTitle={listTitle("活动")}
      refreshable={async () => { await load() }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      {...LIST_STYLE}
    >
      <Section>
        <VStack {...BARE_ROW}>
          <ActivityChips />
        </VStack>
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{connectErrorText(error, "加载失败")}</Text>
        </Section>
      ) : null}
      {events === null ? (
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      ) : events.length === 0 ? (
        <Section>
          <EmptyState icon="bell.slash" title="暂无事件" message="配置重载、网络切换等引擎事件会出现在这里" />
        </Section>
      ) : (
        <Section header={<Text>{`${events.length} 条事件`}</Text>}>
          {events.map((e) => {
            const v = eventVisual(e)
            return (
              <HStack key={e.identifier} spacing={12} alignment="top">
                <IconBadge icon={v.icon} tone={v.tone} size={30} />
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={14} fontWeight="medium" lineLimit={4}>
                    {e.content ?? e.identifier}
                  </Text>
                  <Text font={11} fontDesign="rounded" monospacedDigit foregroundStyle="tertiaryLabel">
                    {formatEventTime(e.date)}
                  </Text>
                </VStack>
              </HStack>
            )
          })}
        </Section>
      )}
    </List>
  )
}
