// 分流 → 策略组：策略组列表 + 节点钻取
import {
  Button,
  HStack,
  Image,
  List,
  NavigationLink,
  ProgressView,
  Script,
  Section,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"
import {
  getPolicies,
  getPoliciesWithExternal,
  getPolicyBenchmarks,
  getPolicyDetail,
  getPolicyGroupSelection,
  getPolicyGroups,
  getGroupTestResults,
  getProxyGroupOrder,
  orderPolicyGroupNames,
  selectPolicyGroup,
  surgeApiErrorMessage,
  testPolicies,
  testPoliciesByIdentifier,
  testPolicyGroup,
  type PolicyBenchmarkResult,
  type PolicyOption,
} from "../lib/surgeApi"
import { formatDelay, pickBenchmark, resolvePolicyLatency, testResultScore, type LatencyStatus } from "../lib/metrics"
import { useStoreSelector } from "../lib/store"
import { useTabAutoRefresh } from "../lib/liveCache"
import { connectErrorText, IS_GLASS, TONES } from "../lib/ui"
import { BARE_ROW, Card, EmptyState, IconBadge, LIST_STYLE, SearchField, Tag, latencyTone } from "../components/Kit"
import { RoutingChips } from "../components/SegmentChips"

function DelayLabel({
  status,
  ms,
  showNone = false,
}: {
  status: LatencyStatus
  ms?: number
  showNone?: boolean
}) {
  if (status === "testing") return <ProgressView />
  if (status === "fail") return <DelayPill text="失败" fg={TONES.red.fg} bg={TONES.red.soft} />
  if (status === "ms" && ms != null) {
    const t = TONES[latencyTone(ms)]
    return <DelayPill text={formatDelay(ms)} fg={t.fg} bg={t.soft} />
  }
  if (!showNone) return null
  return <DelayPill text="未测速" fg="tertiaryLabel" bg={TONES.gray.soft} />
}

function DelayPill({ text, fg, bg }: { text: string; fg: any; bg: any }) {
  return (
    <Text
      font={12}
      fontWeight="semibold"
      fontDesign="rounded"
      monospacedDigit
      foregroundStyle={fg}
      padding={{ horizontal: 8, vertical: 3 }}
      background={{ style: bg, shape: "capsule" }}
    >
      {text}
    </Text>
  )
}

export function PoliciesView() {
  const config = useStoreSelector((s) => s.config)
  const [groups, setGroups] = useState<Record<string, PolicyOption[]> | null>(null)
  const [groupOrder, setGroupOrder] = useState<string[]>([])
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, PolicyBenchmarkResult> | null>(null)
  const [testResults, setTestResults] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")

  async function load(force = false) {
    setLoading(true)
    setError(null)
    try {
      const [g, bm, tr] = await Promise.all([
        getPolicyGroups(config),
        getPolicyBenchmarks(config).catch(() => ({}) as Record<string, PolicyBenchmarkResult>),
        getGroupTestResults(config).catch(() => ({}) as Record<string, unknown>),
      ])
      setGroups(g)
      setBenchmarks(bm ?? {})
      setTestResults(tr ?? {})
      const apiNames = Object.keys(g)
      try {
        // 组顺序解析自整份配置，已做内存缓存；下拉刷新时强制重取
        const order = await getProxyGroupOrder(config, force)
        setGroupOrder(orderPolicyGroupNames(apiNames, order))
      } catch {
        setGroupOrder(apiNames)
      }
      // 逐组查询当前选中项（url-test 等组可能不支持，忽略失败）
      const results = await Promise.all(
        apiNames.map(async (n) => {
          try {
            const r = await getPolicyGroupSelection(config, n)
            return [n, r.policy] as const
          } catch {
            return null
          }
        })
      )
      const sel: Record<string, string> = {}
      for (const r of results) if (r) sel[r[0]] = r[1]
      setSelections(sel)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useTabAutoRefresh("routing", () => load())

  const names = groups ? (groupOrder.length ? groupOrder : Object.keys(groups)) : []
  const q = query.trim().toLowerCase()
  const filtered = q ? names.filter((n) => n.toLowerCase().includes(q)) : names

  return (
    <List
      navigationTitle={Script.env === "home_screen" ? undefined : "分流"}
      refreshable={async () => { await load(true) }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      {...LIST_STYLE}
    >
      <Section>
        <VStack {...BARE_ROW}>
          <RoutingChips />
        </VStack>
      </Section>
      <Section>
        <SearchField value={query} onChanged={setQuery} prompt="策略组名称" />
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{connectErrorText(error, "加载失败")}</Text>
          <Button title="重试" systemImage="arrow.clockwise" action={() => load(true)} />
        </Section>
      ) : null}
      {loading && !groups ? (
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      ) : null}
      {groups ? (
        <Section
          header={<Text>{q ? `${filtered.length} / ${names.length} 个策略组` : `${names.length} 个策略组`}</Text>}
          footer={<Text font={12}>延迟来自 Surge 基准测试缓存；点按策略组切换节点</Text>}
        >
          {filtered.length === 0 ? (
            <EmptyState icon="square.stack.3d.up.slash" title={q ? "无匹配策略组" : "暂无策略组"} />
          ) : (
            filtered.map((name) => {
            const options = groups[name]
            const selected = selections[name]
            const selectedOpt = selected ? options.find((o) => o.name === selected) : undefined
            const lat = resolvePolicyLatency({
              benchmark: pickBenchmark(benchmarks, selectedOpt ?? { name: selected ?? "" }),
              testScore: selected ? testResultScore(testResults, name, selected) : undefined,
            })
            return (
              <NavigationLink
                key={name}
                destination={
                  <GroupDetailView
                    groupName={name}
                    options={options}
                    initialSelection={selected ?? null}
                    initialBenchmarks={benchmarks}
                    initialTestResults={testResults}
                    onChanged={() => {
                      getPolicyGroupSelection(config, name)
                        .then((r) => setSelections((s) => ({ ...s, [name]: r.policy })))
                        .catch(() => {})
                    }}
                  />
                }
              >
                <HStack spacing={12}>
                  <IconBadge icon="square.stack.3d.up.fill" tone="accent" size={34} />
                  <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    <Text font={16} fontWeight="semibold" lineLimit={1} minScaleFactor={0.8}>{name}</Text>
                    <HStack spacing={4}>
                      {selected ? (
                        <Image systemName="arrow.turn.down.right" font={10} foregroundStyle="tertiaryLabel" />
                      ) : null}
                      <Text font={13} foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
                        {selected ?? `${options.length} 个选项`}
                      </Text>
                    </HStack>
                  </VStack>
                  <DelayLabel status={lat.status} ms={lat.ms} />
                </HStack>
              </NavigationLink>
            )
          })
          )}
        </Section>
      ) : null}
    </List>
  )
}

function NestedGroupLoader({ name }: { name: string }) {
  const config = useStoreSelector((s) => s.config)
  const [options, setOptions] = useState<PolicyOption[] | null>(null)
  const [selection, setSelection] = useState<string | null>(null)

  useEffect(() => {
    getPolicyGroups(config)
      .then((g) => setOptions(g[name] ?? []))
      .catch(() => setOptions([]))
    getPolicyGroupSelection(config, name)
      .then((r) => setSelection(r.policy))
      .catch(() => setSelection(null))
  }, [config, name])

  if (!options) {
    return (
      <List navigationTitle={name} {...LIST_STYLE}>
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      </List>
    )
  }
  return (
    <GroupDetailView
      groupName={name}
      options={options}
      initialSelection={selection}
      onChanged={() => {
        getPolicyGroupSelection(config, name)
          .then((r) => setSelection(r.policy))
          .catch(() => {})
      }}
    />
  )
}

export function GroupDetailView({
  groupName,
  options,
  initialSelection,
  initialBenchmarks = null,
  initialTestResults = null,
  onChanged,
}: {
  groupName: string
  options: PolicyOption[]
  initialSelection: string | null
  initialBenchmarks?: Record<string, PolicyBenchmarkResult> | null
  initialTestResults?: Record<string, unknown> | null
  onChanged: () => void
}) {
  const config = useStoreSelector((s) => s.config)
  const [selection, setSelection] = useState<string | null>(initialSelection)
  const [standalone, setStandalone] = useState<Set<string> | null>(null)
  const [externalIds, setExternalIds] = useState<Record<string, string>>({})
  const [details, setDetails] = useState<Record<string, string>>({})
  const [delays, setDelays] = useState<Record<string, number | null>>({})
  const [elected, setElected] = useState<string[] | null>(null)
  // 是否为 url-test/fallback/load-balance 自动组（只有这类组的组测速是真基准测试）
  const [autoGroup, setAutoGroup] = useState<boolean | null>(null)
  // 自动组当前已当选节点（来自既有 test_results，未测速也可展示）
  const [autoElected, setAutoElected] = useState<string[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [testProgress, setTestProgress] = useState("")
  const [selecting, setSelecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Surge 基准测试缓存（按 lineHash / 策略名），覆盖所有节点含内嵌/链式
  const [benchmarks, setBenchmarks] = useState<Record<
    string,
    PolicyBenchmarkResult
  > | null>(initialBenchmarks)
  const [groupTests, setGroupTests] = useState<Record<string, unknown> | null>(initialTestResults)

  function refreshBenchmarks() {
    return getPolicyBenchmarks(config)
      .then((r) => setBenchmarks(r ?? {}))
      .catch(() => setBenchmarks({}))
  }

  useEffect(() => {
    refreshBenchmarks()
  }, [config])

  // 独立策略（/v1/policies）可用 /v1/policies/test 测延迟；policy-path 外部节点只能凭 identifier 走脚本测速
  useEffect(() => {
    let cancelled = false
    getPoliciesWithExternal(config)
      .catch(() => getPolicies(config).then((r) => ({ proxies: r.proxies, external: null })))
      .then((r) => {
        if (cancelled) return
        setStandalone(new Set(r.proxies))
        const ids: Record<string, string> = {}
        for (const p of r.external ?? []) if (p.group === groupName) ids[p.name] = p.identifier
        setExternalIds(ids)
      })
      .catch(() => {
        if (!cancelled) setStandalone(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [config, groupName])

  const isStandalone = (name: string) => standalone?.has(name) ?? false
  const externalId = (name: string) => (isStandalone(name) ? undefined : externalIds[name])
  const externalCount = options.filter((o) => !o.isGroup && externalId(o.name)).length

  // test_results 只包含 url-test/fallback/load-balance 组——据此判断组类型
  useEffect(() => {
    let cancelled = false
    getGroupTestResults(config)
      .then((r) => {
        if (cancelled) return
        setGroupTests(r ?? {})
        const keys = Object.keys(r ?? {})
        setAutoGroup(keys.includes(groupName))
        const cur = r?.[groupName]
        if (Array.isArray(cur)) {
          setAutoElected(
            cur.map((v) => (typeof v === "string" ? v : v.policy))
          )
        }
      })
      .catch(() => {
        if (!cancelled) setAutoGroup(false)
      })
    return () => {
      cancelled = true
    }
  }, [config, groupName])

  // 独立策略拉取原始配置行展示
  useEffect(() => {
    if (!standalone) return
    let cancelled = false
    options
      .filter((o) => !o.isGroup && standalone.has(o.name))
      .forEach((o) => {
        getPolicyDetail(config, o.name)
          .then((r) => {
            const v = r?.[o.name]
            if (v && !cancelled) setDetails((d) => ({ ...d, [o.name]: v }))
          })
          .catch(() => {})
      })
    return () => {
      cancelled = true
    }
  }, [standalone, config])

  async function select(policy: string) {
    if (policy === selection || selecting) return
    setSelecting(policy)
    setError(null)
    try {
      await selectPolicyGroup(config, groupName, policy)
      setSelection(policy)
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setSelecting(null)
    }
  }

  async function testAll() {
    if (testing) return
    setTesting(true)
    setError(null)
    setDelays({})
    setElected(null)

    // 1) 组测速：仅自动组（url-test 等）是真基准测试；select 手动组只会回显当前选中，跳过
    const groupTest = (async () => {
      if (autoGroup !== true) return
      try {
        setTestProgress("组测速中…")
        const r = await testPolicyGroup(config, groupName)
        setElected(r?.available ?? [])
      } catch {
        // 部分组类型不支持，忽略
      }
    })()

    // 2) 独立策略逐个测延迟（任一节点失败会导致整批响应为空，故逐个调用）
    const latencyTest = (async () => {
      const names = options
        .filter((o) => !o.isGroup && o.enabled && isStandalone(o.name))
        .map((o) => o.name)
      const result: Record<string, number | null> = {}
      let done = 0
      for (const n of names) {
        try {
          const r = await testPolicies(config, [n])
          const v = r ? r[n]?.["round-one-total"] : undefined
          result[n] = typeof v === "number" ? v : null
        } catch {
          result[n] = null
        }
        done++
        setTestProgress(`延迟测试 ${done}/${names.length}…`)
        setDelays((d) => ({ ...d, ...result }))
      }
    })()

    // 3) 外部策略组节点：按 identifier 经 $httpClient 测速
    const externalTest = (async () => {
      const targets = options
        .filter((o) => !o.isGroup && o.enabled && externalId(o.name))
        .map((o) => ({ name: o.name, id: externalId(o.name)! }))
      if (targets.length === 0) return
      const toNames = (byId: Record<string, number | null>) => {
        const out: Record<string, number | null> = {}
        for (const t of targets) if (t.id in byId) out[t.name] = byId[t.id]
        return out
      }
      try {
        await testPoliciesByIdentifier(
          config,
          targets.map((t) => t.id),
          (partial) => {
            setDelays((d) => ({ ...d, ...toNames(partial) }))
            setTestProgress(`外部节点 ${Object.keys(partial).length}/${targets.length}…`)
          }
        )
      } catch (e) {
        setError(`外部节点测速失败：${surgeApiErrorMessage(e)}`)
      }
    })()

    await Promise.all([groupTest, latencyTest, externalTest])
    // 组测速完成后 Surge 会更新基准测试缓存，重新拉取以刷新所有节点的延迟显示
    await refreshBenchmarks()
    await getGroupTestResults(config)
      .then((r) => setGroupTests(r ?? {}))
      .catch(() => {})
    setTestProgress("")
    setTesting(false)
  }

  const selectedOpt = selection ? options.find((o) => o.name === selection) : undefined

  return (
    <List navigationTitle={groupName} navigationBarTitleDisplayMode="inline" {...LIST_STYLE}>
      <Section
        footer={
          <Text font={12}>
            {autoGroup === false
              ? "点按节点即可切换。延迟来自 Surge 基准测试缓存（含内嵌/链式节点，由 Surge 后台定期自动更新）；手动选择组不支持面板内组测速"
              : "点按节点即可切换。延迟来自 Surge 基准测试缓存与组测速结果；「全部测速」会刷新本组。绿色「最优」为自动组当选节点"}
            {externalCount > 0
              ? `\n${externalCount} 个「外部」节点来自 policy-path，「全部测速」经脚本 $httpClient 逐个请求（需开启脚本功能），数值为完整 HTTP 耗时`
              : ""}
          </Text>
        }
      >
        <VStack {...BARE_ROW}>
          <Card>
            <HStack spacing={8}>
              <Text font={12} fontWeight="semibold" foregroundStyle="secondaryLabel">当前节点</Text>
              <Spacer />
              {autoGroup === null ? null : (
                <Tag text={autoGroup ? "自动组" : "手动选择"} tone={autoGroup ? "green" : "accent"} />
              )}
              <Tag text={`${options.length} 个选项`} />
            </HStack>
            <Text font={24} fontWeight="bold" fontDesign="rounded" lineLimit={1} minScaleFactor={0.6}>
              {selection ?? "—"}
            </Text>
            {selectedOpt ? (
              <Text font={13} foregroundStyle="secondaryLabel" lineLimit={1}>{selectedOpt.typeDescription}</Text>
            ) : null}
            <HStack spacing={10}>
              <Button
                title={testing ? "测速中…" : "全部测速"}
                systemImage="speedometer"
                buttonStyle={IS_GLASS ? "glassProminent" : "borderedProminent"}
                tint={TONES.accent.fg}
                disabled={testing}
                action={testAll}
              />
              {testing ? (
                <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{testProgress || "测速中…"}</Text>
              ) : null}
            </HStack>
          </Card>
        </VStack>
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{error}</Text>
        </Section>
      ) : null}
      <Section header={<Text>节点</Text>}>
        {options.map((o) => {
          const isSelected = o.name === selection
          const delay = delays[o.name]
          const electedList = elected ?? autoElected
          const isElected =
            autoGroup === true && (electedList?.includes(o.name) ?? false)
          const lat = resolvePolicyLatency({
            live: delay,
            benchmark: pickBenchmark(benchmarks, o),
            testScore: testResultScore(groupTests, groupName, o.name),
          })
          return (
            <HStack
              key={o.lineHash}
              spacing={12}
              contentShape="rect"
              onTapGesture={() => select(o.name)}
            >
              {selecting === o.name ? (
                <ProgressView frame={{ width: 22 }} />
              ) : (
                <Image
                  systemName={isSelected ? "checkmark.circle.fill" : "circle"}
                  foregroundStyle={isSelected ? TONES.accent.fg : "tertiaryLabel"}
                  font={20}
                  frame={{ width: 22 }}
                />
              )}
              <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <HStack spacing={6}>
                  <Text font={16} fontWeight={isSelected ? "semibold" : "regular"} lineLimit={1} minScaleFactor={0.7}>{o.name}</Text>
                  {isElected ? <Tag text="最优" tone="green" /> : null}
                  {externalId(o.name) ? <Tag text="外部" tone="teal" /> : null}
                </HStack>
                <Text font={12} foregroundStyle="secondaryLabel">{o.typeDescription}</Text>
                {details[o.name] ? (
                  <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel" lineLimit={1} minScaleFactor={0.7}>
                    {details[o.name]}
                  </Text>
                ) : null}
              </VStack>
              <DelayLabel status={lat.status} ms={lat.ms} showNone={!o.isGroup} />
              {o.isGroup ? (
                <NavigationLink title="子组" destination={<NestedGroupLoader name={o.name} />} />
              ) : null}
            </HStack>
          )
        })}
      </Section>
    </List>
  )
}
