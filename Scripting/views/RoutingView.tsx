// 分流 Tab：策略组 / 规则
import { useStoreSelector } from "../lib/store"
import { PoliciesView } from "./PoliciesView"
import { RulesView } from "./RulesView"

export function RoutingView() {
  const segment = useStoreSelector((s) => s.routingSegment)
  return segment === "rules" ? <RulesView /> : <PoliciesView />
}
