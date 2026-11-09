// 分流 / 活动 Tab 顶部分段芯片，放进 List / ScrollView 内以便下拉刷新作用在整页
import {
  setActivitySegment,
  setRoutingSegment,
  useStoreSelector,
  type ActivitySegment,
  type RoutingSegment,
} from "../lib/store"
import { ChipBar, type ChipItem } from "./Kit"

const ROUTING_ITEMS: ChipItem<RoutingSegment>[] = [
  { id: "groups", title: "策略组", icon: "square.stack.3d.up" },
  { id: "rules", title: "规则", icon: "list.bullet.indent" },
]

const ACTIVITY_ITEMS: ChipItem<ActivitySegment>[] = [
  { id: "traffic", title: "流量", icon: "chart.bar.xaxis" },
  { id: "connections", title: "连接", icon: "link" },
  { id: "dns", title: "DNS", icon: "server.rack" },
  { id: "events", title: "事件", icon: "bell" },
]

export function RoutingChips() {
  const segment = useStoreSelector((s) => s.routingSegment)
  return <ChipBar items={ROUTING_ITEMS} value={segment} onChange={setRoutingSegment} />
}

export function ActivityChips() {
  const segment = useStoreSelector((s) => s.activitySegment)
  return <ChipBar items={ACTIVITY_ITEMS} value={segment} onChange={setActivitySegment} />
}
