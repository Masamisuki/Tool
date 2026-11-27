// 分流 → 规则：全量规则 + 搜索/类型/策略筛选
import {
  HStack,
  List,
  Picker,
  Script,
  Section,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"
import { getRules, surgeApiErrorMessage } from "../lib/surgeApi"
import { needsSetup, useStoreSelector } from "../lib/store"
import { connectErrorText, type Tone } from "../lib/ui"
import { BARE_ROW, EmptyState, LIST_STYLE, SearchField, Tag } from "../components/Kit"
import { RoutingChips } from "../components/SegmentChips"

type ParsedRule = {
  raw: string
  type: string
  value: string
  policy: string
  module: string | null
}

/** 规则尾部修饰符：它们不是策略名，展示前要从尾部剥掉 */
const RULE_MODIFIERS = new Set([
  "no-resolve",
  "extended-matching",
  "pre-matching",
  "src",
  "force-remote-dns",
])

function parseRule(raw: string): ParsedRule {
  let module: string | null = null
  let body = raw
  const idx = raw.indexOf("#!FROM-MODULE:")
  if (idx >= 0) {
    module = raw.slice(idx + "#!FROM-MODULE:".length).trim()
    body = raw.slice(0, idx).trim()
  }
  // 不能裸 split：值里可能出现逗号（逻辑规则 AND,((a),(b)),策略），
  // 尾部还可能有 no-resolve / extended-matching 这类修饰符，直接取 parts[2] 会取到修饰符当策略名
  const parts = body.split(",").map((part) => part.trim())
  while (parts.length > 2 && RULE_MODIFIERS.has(parts[parts.length - 1].toLowerCase())) parts.pop()
  const type = parts[0] ?? ""
  // FINAL,策略 只有两段
  const policy = parts.length >= 2 ? parts[parts.length - 1] : ""
  const value = parts.length >= 3 ? parts.slice(1, -1).join(",") : ""
  return { raw, type, value, policy, module }
}

const TYPE_TONES: Record<string, Tone> = {
  DOMAIN: "blue",
  "DOMAIN-SUFFIX": "accent",
  "DOMAIN-KEYWORD": "purple",
  "IP-CIDR": "teal",
  "IP-CIDR6": "teal",
  GEOIP: "orange",
  "RULE-SET": "pink",
  FINAL: "gray",
}

export function RulesView() {
  const config = useStoreSelector((s) => s.config)
  const [rules, setRules] = useState<ParsedRule[] | null>(null)
  const [policies, setPolicies] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("__all__")
  const [policyFilter, setPolicyFilter] = useState("__all__")

  async function load() {
    if (needsSetup()) return
    try {
      const r = await getRules(config)
      setRules(r.rules.map(parseRule))
      setPolicies(r["available-policies"] ?? [])
      setError(null)
    } catch (e) {
      setError(surgeApiErrorMessage(e))
    }
  }

  // 规则只在配置重载时变化：进入分段拉一次即可，下拉可手动刷新，不随面板周期轮询
  useEffect(() => {
    void load()
  }, [config])

  const types = rules ? [...new Set(rules.map((r) => r.type))].sort() : []

  const filtered = (rules ?? []).filter((r) => {
    if (typeFilter !== "__all__" && r.type !== typeFilter) return false
    if (policyFilter !== "__all__" && r.policy !== policyFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        r.value.toLowerCase().includes(q) ||
        r.policy.toLowerCase().includes(q) ||
        (r.module?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  return (
    <List
      navigationTitle={Script.env === "home_screen" ? undefined : "分流"}
      refreshable={async () => { await load() }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      {...LIST_STYLE}
    >
      <Section>
        <VStack {...BARE_ROW}>
          <RoutingChips />
        </VStack>
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{connectErrorText(error, "加载失败")}</Text>
        </Section>
      ) : null}

      {/* 筛选 */}
      <Section>
        <SearchField value={search} onChanged={setSearch} prompt="域名 / 策略 / 模块" />
        <Picker title="类型" value={typeFilter} onChanged={setTypeFilter}>
          <Text tag="__all__">全部类型</Text>
          {types.map((t) => (
            <Text key={t} tag={t}>{t}</Text>
          ))}
        </Picker>
        <Picker title="策略" value={policyFilter} onChanged={setPolicyFilter}>
          <Text tag="__all__">全部策略</Text>
          {policies.map((p) => (
            <Text key={p} tag={p}>{p}</Text>
          ))}
        </Picker>
      </Section>

      {/* 规则列表 */}
      {rules === null ? (
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      ) : (
        <Section
          header={<Text>{`${filtered.length} / ${rules.length} 条规则`}</Text>}
          footer={<Text font={12}>规则按配置文件顺序匹配，越靠前优先级越高</Text>}
        >
          {filtered.length === 0 ? (
            <EmptyState icon="line.3.horizontal.decrease.circle" title="无匹配规则" />
          ) : (
            filtered.map((r, i) => (
              <VStack key={`${i}-${r.raw}`} alignment="leading" spacing={4}>
                <HStack spacing={6}>
                  <Tag text={r.type} tone={TYPE_TONES[r.type] ?? "gray"} mono />
                  <Spacer />
                  <Text font={12} fontWeight="medium" foregroundStyle="secondaryLabel" lineLimit={1}>{r.policy}</Text>
                </HStack>
                {r.value ? (
                  <Text font={14} fontDesign="monospaced" lineLimit={1} minScaleFactor={0.6}>{r.value}</Text>
                ) : null}
                {r.module ? (
                  <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>
                    {`来自模块：${r.module}`}
                  </Text>
                ) : null}
              </VStack>
            ))
          )}
        </Section>
      )}
    </List>
  )
}
