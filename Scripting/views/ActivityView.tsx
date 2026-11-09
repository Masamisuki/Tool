// 活动 Tab：流量 / 连接 / DNS / 事件
import { useStoreSelector } from "../lib/store"
import { TrafficView } from "./TrafficView"
import { ConnectionsView } from "./ConnectionsView"
import { DnsView } from "./DnsView"
import { EventsView } from "./EventsView"

export function ActivityView() {
  const segment = useStoreSelector((s) => s.activitySegment)
  if (segment === "connections") return <ConnectionsView />
  if (segment === "dns") return <DnsView />
  if (segment === "events") return <EventsView />
  return <TrafficView />
}
