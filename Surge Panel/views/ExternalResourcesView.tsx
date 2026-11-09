// 设置 → 外部资源：规则集 / 域名集 / 脚本 / 策略组列表的下载状态与手动更新（iOS 5.23+ / Mac 6.10+）
import {
  Button,
  Group,
  HStack,
  List,
  NavigationLink,
  ProgressView,
  Section,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"
import {
  getExternalResources,
  surgeApiErrorKind,
  surgeApiErrorMessage,
  updateExternalResource,
  API_523_MIN_VERSION,
  type ExternalResource,
} from "../lib/surgeApi"
import {
  formatAge,
  formatRequestDateTime,
  resourceDisplayName,
  resourceHost,
  resourceStatus,
  type ResourceStatus,
} from "../lib/metrics"
import { needsSetup, useStoreSelector } from "../lib/store"
import { TONES, type Tone } from "../lib/ui"
import { UnsupportedApiNotice } from "../components/ApiUnsupported"
import { BARE_ROW, ChipBar, EmptyState, IconBadge, InfoRow, LIST_STYLE, ListRow, Tag, type ChipItem } from "../components/Kit"

type TypeMeta = { label: string; icon: string; tone: Tone }

const TYPE_META: Record<string, TypeMeta> = {
  ruleset: { label: "规则集", icon: "list.bullet.rectangle.fill", tone: "blue" },
  domainset: { label: "域名集", icon: "globe", tone: "teal" },
  script: { label: "脚本", icon: "curlybraces", tone: "purple" },
  "policy-group": { label: "策略组", icon: "square.stack.3d.up.fill", tone: "orange" },
  data: { label: "数据", icon: "doc.fill", tone: "gray" },
}

const TYPE_ORDER = ["ruleset", "domainset", "script", "policy-group", "data"]

function typeMeta(type: string): TypeMeta {
  return TYPE_META[type] ?? { label: type || "未知", icon: "questionmark.square.dashed", tone: "gray" }
}

const STATUS_TAG: Partial<Record<ResourceStatus, { text: string; tone: Tone }>> = {
  updating: { text: "更新中", tone: "accent" },
  error: { text: "错误", tone: "red" },
  never: { text: "未下载", tone: "orange" },
  pending: { text: "未就绪", tone: "orange" },
  local: { text: "本地", tone: "gray" },
}

type UpdateOutcome = { ok: boolean; text: string }

function outcomeOf(key: string, result: Record<string, string> | undefined): UpdateOutcome {
  const v = result?.[key]
  if (v === undefined || v === "success") return { ok: true, text: "已更新" }
  return { ok: false, text: v }
}

function summarizeAll(result: Record<string, string> | undefined): UpdateOutcome {
  const values = Object.values(result ?? {})
  const failed = values.filter((v) => v !== "success").length
  const ok = values.length - failed
  if (values.length === 0) return { ok: true, text: "没有需要更新的远程资源" }
  if (failed === 0) return { ok: true, text: `已更新 ${ok} 项` }
  return { ok: false, text: `已更新 ${ok} 项，${failed} 项失败` }
}

function normalize(list: ExternalResource[] | undefined): ExternalResource[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((r) => r && typeof r.key === "string")
    .map((r) => ({ ...r, path: String(r.path ?? ""), type: String(r.type ?? ""), local: Boolean(r.local), ready: Boolean(r.ready) }))
}

function matches(r: ExternalResource, q: string): boolean {
  if (!q) return true
  return `${r.path} ${r.fromModule ?? ""} ${typeMeta(r.type).label}`.toLowerCase().includes(q)
}

/** 来源分组：配置在前，模块按名称 */
function groupByOrigin(list: ExternalResource[]): { origin: string | null; items: ExternalResource[] }[] {
  const map = new Map<string | null, ExternalResource[]>()
  for (const r of list) {
    const k = r.fromModule || null
    const arr = map.get(k)
    if (arr) arr.push(r)
    else map.set(k, [r])
  }
  const typeRank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t)
    return i < 0 ? TYPE_ORDER.length : i
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([origin, items]) => ({
      origin,
      items: items.slice().sort((x, y) => typeRank(x.type) - typeRank(y.type) || resourceDisplayName(x.path).localeCompare(resourceDisplayName(y.path))),
    }))
}

export function ExternalResourcesView() {
  const config = useStoreSelector((s) => s.config)
  const [list, setList] = useState<ExternalResource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState<unknown>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [busyKeys, setBusyKeys] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<Record<string, UpdateOutcome>>({})
  const [allOutcome, setAllOutcome] = useState<UpdateOutcome | null>(null)

  async function load() {
    if (needsSetup()) {
      setList(null)
      setError(null)
      return
    }
    try {
      const r = await getExternalResources(config)
      setList(normalize(r?.defines))
      setError(null)
      setUnsupported(null)
    } catch (e) {
      if (surgeApiErrorKind(e) === "unsupported") {
        setUnsupported(e)
        setList([])
        setError(null)
      } else {
        setError(surgeApiErrorMessage(e))
      }
    }
  }

  useEffect(() => {
    void load()
  }, [config])

  async function updateOne(key: string) {
    if (busyKeys.includes(key) || busyKeys.includes("all")) return
    setBusyKeys((b) => [...b, key])
    try {
      const r = await updateExternalResource(config, key)
      setOutcomes((o) => ({ ...o, [key]: outcomeOf(key, r) }))
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { ok: false, text: surgeApiErrorMessage(e) } }))
    } finally {
      setBusyKeys((b) => b.filter((k) => k !== key))
      await load()
    }
  }

  async function updateAll() {
    if (busyKeys.length > 0) return
    setBusyKeys(["all"])
    setAllOutcome(null)
    try {
      const r = await updateExternalResource(config, "all")
      setAllOutcome(summarizeAll(r))
      const next: Record<string, UpdateOutcome> = {}
      for (const k of Object.keys(r ?? {})) next[k] = outcomeOf(k, r)
      setOutcomes(next)
    } catch (e) {
      setAllOutcome({ ok: false, text: `更新失败：${surgeApiErrorMessage(e)}` })
    } finally {
      setBusyKeys([])
      await load()
    }
  }

  const all = list ?? []
  const q = query.trim().toLowerCase()
  const typesPresent = TYPE_ORDER.filter((t) => all.some((r) => r.type === t)).concat(
    [...new Set(all.map((r) => r.type))].filter((t) => !TYPE_ORDER.includes(t))
  )
  const chips: ChipItem<string>[] = [
    { id: "all", title: "全部", count: all.length },
    ...typesPresent.map((t) => ({
      id: t,
      title: typeMeta(t).label,
      icon: typeMeta(t).icon,
      count: all.filter((r) => r.type === t).length,
    })),
  ]
  const activeFilter = filter === "all" || typesPresent.includes(filter) ? filter : "all"
  const shown = all.filter((r) => (activeFilter === "all" || r.type === activeFilter) && matches(r, q))
  const groups = groupByOrigin(shown)

  const remote = all.filter((r) => !r.local)
  const statuses = all.map((r) => resourceStatus(r))
  const readyCount = statuses.filter((s) => s === "ready" || s === "local").length
  const errorCount = statuses.filter((s) => s === "error").length
  const waitingCount = statuses.filter((s) => s === "never" || s === "pending" || s === "updating").length
  const updatingAll = busyKeys.includes("all")

  return (
    <List
      {...LIST_STYLE}
      navigationTitle="外部资源"
      refreshable={async () => { await load() }}
      searchable={unsupported ? undefined : {
        value: query,
        onChanged: setQuery,
        prompt: "URL / 文件名 / 模块",
        placement: "navigationBarDrawer",
      }}
    >
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{`加载失败：${error}`}</Text>
        </Section>
      ) : null}

      {unsupported ? (
        <Section footer={<Text font={12}>{`官方文档标注：${API_523_MIN_VERSION}。`}</Text>}>
          <UnsupportedApiNotice
            feature="外部资源"
            endpoint="GET /v1/external_resources"
            error={unsupported}
            onRetry={() => { void load() }}
          />
        </Section>
      ) : list === null ? (
        error ? null : (
          <Section>
            <EmptyState icon="hourglass" title={needsSetup() ? "连接实例后可用" : "加载中…"} />
          </Section>
        )
      ) : (
        <Group>
          <Section
            footer={
              allOutcome ? (
                <Text font={12} foregroundStyle={allOutcome.ok ? TONES.green.fg : TONES.red.fg}>{allOutcome.text}</Text>
              ) : (
                <Text font={12}>仅下载远程资源，本地文件会被跳过。Surge 下载完成后才返回结果。</Text>
              )
            }
          >
            <HStack spacing={10} padding={{ vertical: 4 }}>
              <SummaryStat label="就绪" value={readyCount} tone="green" />
              <SummaryStat label="异常" value={errorCount} tone={errorCount > 0 ? "red" : "gray"} />
              <SummaryStat label="待下载" value={waitingCount} tone={waitingCount > 0 ? "orange" : "gray"} />
            </HStack>
            <Button disabled={busyKeys.length > 0 || remote.length === 0} action={() => { void updateAll() }}>
              <HStack spacing={12}>
                <IconBadge icon="arrow.down.circle.fill" tone="accent" size={30} filled />
                <Text font={16} foregroundStyle={remote.length === 0 ? "secondaryLabel" : "label"} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  {updatingAll ? "正在更新全部…" : `全部更新（${remote.length} 项远程资源）`}
                </Text>
                {updatingAll ? <ProgressView /> : null}
              </HStack>
            </Button>
          </Section>

          {chips.length > 2 ? (
            <Section>
              <VStack {...BARE_ROW}>
                <ChipBar items={chips} value={activeFilter} onChange={setFilter} />
              </VStack>
            </Section>
          ) : null}

          {all.length === 0 ? (
            <Section>
              <EmptyState icon="tray" title="没有外部资源" message="当前配置与已启用模块没有引用 RULE-SET、DOMAIN-SET、脚本或外部策略组。" />
            </Section>
          ) : groups.length === 0 ? (
            <Section>
              <EmptyState icon="magnifyingglass" title="无匹配资源" />
            </Section>
          ) : (
            groups.map((g) => (
              <Section key={g.origin ?? "__profile"} header={<Text>{`${g.origin ? `模块 · ${g.origin}` : "配置"} · ${g.items.length}`}</Text>}>
                {g.items.map((r) => (
                  <NavigationLink
                    key={r.key}
                    destination={
                      <ExternalResourceDetailView
                        initial={r}
                        onUpdated={(o) => {
                          setOutcomes((prev) => ({ ...prev, [r.key]: o }))
                          void load()
                        }}
                      />
                    }
                  >
                    <ResourceRow
                      r={r}
                      busy={busyKeys.includes(r.key) || (updatingAll && !r.local)}
                      outcome={outcomes[r.key]}
                      onUpdate={r.local ? undefined : () => { void updateOne(r.key) }}
                    />
                  </NavigationLink>
                ))}
              </Section>
            ))
          )}
        </Group>
      )}
    </List>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  const t = TONES[tone]
  return (
    <VStack spacing={2} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }} background={{ style: t.soft, shape: { type: "rect", cornerRadius: 12, style: "continuous" } }}>
      <Text font={22} fontWeight="bold" fontDesign="rounded" monospacedDigit foregroundStyle={t.fg}>{String(value)}</Text>
      <Text font={11} foregroundStyle="secondaryLabel">{label}</Text>
    </VStack>
  )
}

function ResourceRow({
  r,
  busy,
  outcome,
  onUpdate,
}: {
  r: ExternalResource
  busy: boolean
  outcome?: UpdateOutcome
  onUpdate?: () => void
}) {
  const meta = typeMeta(r.type)
  const status = busy ? "updating" : resourceStatus(r)
  const tag = STATUS_TAG[status]
  const age = r.local ? null : formatAge(r.updatedAt)
  const sub = resourceHost(r.path) ?? r.path
  return (
    <HStack
      spacing={12}
      contextMenu={
        onUpdate
          ? { menuItems: <Group><Button title="立即更新" systemImage="arrow.down.circle" action={onUpdate} /></Group> }
          : undefined
      }
    >
      <IconBadge icon={meta.icon} tone={meta.tone} size={30} filled />
      <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={6}>
          <Text font={15} fontWeight="medium" lineLimit={1} minScaleFactor={0.7}>{resourceDisplayName(r.path)}</Text>
          {tag ? <Tag text={tag.text} tone={tag.tone} /> : null}
        </HStack>
        <Text font={11} fontDesign="monospaced" foregroundStyle="secondaryLabel" lineLimit={1}>{sub}</Text>
        {outcome && !busy ? (
          <Text font={11} foregroundStyle={outcome.ok ? TONES.green.fg : TONES.red.fg} lineLimit={2}>{outcome.text}</Text>
        ) : r.error && !busy ? (
          <Text font={11} foregroundStyle={TONES.red.fg} lineLimit={2}>{r.error}</Text>
        ) : null}
      </VStack>
      {busy ? (
        <ProgressView />
      ) : age ? (
        <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{age}</Text>
      ) : null}
    </HStack>
  )
}

function ExternalResourceDetailView({
  initial,
  onUpdated,
}: {
  initial: ExternalResource
  onUpdated: (o: UpdateOutcome) => void
}) {
  const config = useStoreSelector((s) => s.config)
  const [r, setR] = useState<ExternalResource>(initial)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null)
  const meta = typeMeta(r.type)
  const status = busy ? "updating" : resourceStatus(r)
  const tag = STATUS_TAG[status]
  const isWeb = /^https?:\/\//i.test(r.path)

  async function update() {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    let o: UpdateOutcome
    try {
      o = outcomeOf(r.key, await updateExternalResource(config, r.key))
    } catch (e) {
      o = { ok: false, text: surgeApiErrorMessage(e) }
    }
    setOutcome(o)
    try {
      const fresh = normalize((await getExternalResources(config))?.defines).find((x) => x.key === r.key)
      if (fresh) setR(fresh)
    } catch {}
    setBusy(false)
    onUpdated(o)
  }

  const updatedText = r.local
    ? "本地文件"
    : r.updatedAt
      ? `${formatRequestDateTime(r.updatedAt)}（${formatAge(r.updatedAt) ?? ""}）`
      : "从未下载"

  return (
    <List {...LIST_STYLE} navigationTitle={meta.label} navigationBarTitleDisplayMode="inline">
      <Section>
        <HStack spacing={14} padding={{ vertical: 6 }}>
          <IconBadge icon={meta.icon} tone={meta.tone} size={44} filled />
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={17} fontWeight="semibold" lineLimit={2} minScaleFactor={0.7}>{resourceDisplayName(r.path)}</Text>
            <HStack spacing={6}>
              <Tag text={meta.label} tone={meta.tone} />
              {tag ? <Tag text={tag.text} tone={tag.tone} /> : <Tag text="就绪" tone="green" />}
              {r.fromModule ? <Tag text="模块" tone="teal" /> : null}
            </HStack>
          </VStack>
        </HStack>
      </Section>

      <Section header={<Text>路径</Text>}>
        <Text font={12} fontDesign="monospaced" multilineTextAlignment="leading">{r.path}</Text>
      </Section>

      <Section header={<Text>状态</Text>}>
        <InfoRow label="来源" value={r.fromModule ? `模块：${r.fromModule}` : "配置文件"} />
        <InfoRow label="内容可用" value={r.ready ? "是" : "否"} />
        <InfoRow label="上次下载" value={updatedText} />
        <InfoRow label="Key" value={r.key} mono />
      </Section>

      {r.error ? (
        <Section header={<Text>最近错误</Text>}>
          <Text font={13} foregroundStyle={TONES.red.fg}>{r.error}</Text>
        </Section>
      ) : null}

      <Section
        footer={
          outcome ? (
            <Text font={12} foregroundStyle={outcome.ok ? TONES.green.fg : TONES.red.fg}>{outcome.text}</Text>
          ) : r.local ? (
            <Text font={12}>本地资源随配置重载生效，无需下载。</Text>
          ) : undefined
        }
      >
        {r.local ? null : (
          <Button disabled={busy} action={() => { void update() }}>
            <HStack spacing={12}>
              <ListRow icon="arrow.down.circle.fill" tone="accent" title={busy ? "正在更新…" : "立即更新"} titleColor="label" />
              {busy ? <ProgressView /> : null}
            </HStack>
          </Button>
        )}
        {isWeb ? (
          <Button action={() => { void Safari.present(r.path, false) }}>
            <ListRow icon="safari.fill" tone="blue" title="在 Safari 中查看" titleColor="label" />
          </Button>
        ) : null}
      </Section>
    </List>
  )
}
