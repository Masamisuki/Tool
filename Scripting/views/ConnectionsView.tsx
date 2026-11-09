// 活动 → 连接：活动连接 / 最近请求（同一工作台，仅数据源与列尾不同）
import {
  Button,
  HStack,
  Image,
  List,
  NavigationLink,
  Picker,
  Script,
  Section,
  Spacer,
  Text,
  useEffect,
  useState,
  VStack,
} from "scripting"
import { getActiveRequests, getRecentRequests, killRequest, type SurgeRequest } from "../lib/surgeApi"
import {
  extractIpAddress,
  formatBytes,
  formatGeoSummary,
  formatRequestClock,
  formatRequestDateTime,
  formatSpeed,
  isRejectPolicy,
} from "../lib/metrics"
import { setConnectionsMode, useStoreSelector, type ConnectionsMode } from "../lib/store"
import { useTabAutoRefresh } from "../lib/liveCache"
import { connectErrorText, DOWN_TONE, TONES, UP_TONE } from "../lib/ui"
import { BARE_ROW, EmptyState, InfoRow, LIST_STYLE, SearchField, Tag } from "../components/Kit"
import { ActivityChips } from "../components/SegmentChips"
import { useGeoIp } from "../components/GeoIp"

export function listTitle(title: string): string | undefined {
  return Script.env === "home_screen" ? undefined : title
}

export function ConnectionsView() {
  const mode = useStoreSelector((s) => s.connectionsMode)
  // 同一组件承载两种数据源，key 保证切换时重挂载（清掉旧列表与轮询闭包）
  return mode === "active" ? <RequestListView key="active" active /> : <RequestListView key="recent" active={false} />
}

function filterRequests(list: SurgeRequest[], query: string): SurgeRequest[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((r) => {
    const hay = `${r.URL} ${r.remoteHost ?? ""} ${r.policyName} ${r.rule ?? ""} ${r.method ?? ""}`.toLowerCase()
    return hay.includes(q)
  })
}

type StatusFilter = "all" | "failed" | "rejected"

function filterByStatus(list: SurgeRequest[], status: StatusFilter): SurgeRequest[] {
  if (status === "failed") return list.filter((r) => r.failed)
  if (status === "rejected") return list.filter((r) => r.rejected || isRejectPolicy(r.policyName))
  return list
}

function sortRequests(list: SurgeRequest[], sort: string, active?: boolean): SurgeRequest[] {
  const out = list.slice()
  if (sort === "url") {
    out.sort((a, b) => (a.remoteHost ?? a.URL).localeCompare(b.remoteHost ?? b.URL))
  } else if (sort === "size") {
    out.sort((a, b) => ((b.inBytes ?? 0) + (b.outBytes ?? 0)) - ((a.inBytes ?? 0) + (a.outBytes ?? 0)))
  } else {
    const t = (r: SurgeRequest) => (active ? r.startDate : (r.completedDate ?? r.startDate)) ?? 0
    out.sort((a, b) => t(b) - t(a))
  }
  return out
}

function RequestListView({ active }: { active: boolean }) {
  const config = useStoreSelector((s) => s.config)
  const [requests, setRequests] = useState<SurgeRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState("time")
  const [status, setStatus] = useState<StatusFilter>("all")

  async function load() {
    try {
      const r = active ? await getActiveRequests(config) : await getRecentRequests(config)
      setRequests(r.requests.slice().reverse())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  useTabAutoRefresh("activity", load)

  const shown = requests
    ? sortRequests(filterRequests(filterByStatus(requests, active ? "all" : status), query), sort, active)
    : null
  const emptyText = active
    ? query
      ? "无匹配连接"
      : "当前没有活动连接"
    : query || status !== "all"
      ? "无匹配请求"
      : "暂无最近请求"

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
      <Section>
        <Picker
          label={<Text>连接类型</Text>}
          pickerStyle="segmented"
          value={active ? "active" : "recent"}
          onChanged={(v: string) => setConnectionsMode(v as ConnectionsMode)}
        >
          <Text tag="active">活动连接</Text>
          <Text tag="recent">最近请求</Text>
        </Picker>
        <SearchField value={query} onChanged={setQuery} prompt="URL / 主机 / 策略" />
        <Picker title="排序" value={sort} onChanged={setSort}>
          <Text tag="time">时间</Text>
          <Text tag="url">主机</Text>
          <Text tag="size">流量</Text>
        </Picker>
        {active ? null : (
          <Picker title="筛选" value={status} onChanged={(v: string) => setStatus(v as StatusFilter)}>
            <Text tag="all">全部</Text>
            <Text tag="failed">仅失败</Text>
            <Text tag="rejected">仅拒绝</Text>
          </Picker>
        )}
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{connectErrorText(error, "加载失败")}</Text>
        </Section>
      ) : null}
      {shown === null ? (
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      ) : shown.length === 0 ? (
        <Section>
          <EmptyState icon={active ? "link" : "clock.arrow.circlepath"} title={emptyText} />
        </Section>
      ) : (
        <Section
          header={<Text>{`${shown.length} 条${active ? "连接" : "请求"}`}</Text>}
          footer={
            active ? <Text font={12}>点按查看详情，详情页可终止连接；下拉可刷新</Text> : undefined
          }
        >
          {shown.map((r) => (
            <NavigationLink
              key={r.id}
              destination={<RequestDetailView r={r} active={active} onKilled={load} />}
            >
              <RequestRow r={r} active={active} />
            </NavigationLink>
          ))}
        </Section>
      )}
    </List>
  )
}

function RequestRow({ r, active }: { r: SurgeRequest; active?: boolean }) {
  const clock = formatRequestClock(active ? r.startDate : (r.completedDate ?? r.startDate))
  const rejected = r.rejected || isRejectPolicy(r.policyName)
  return (
    <VStack alignment="leading" spacing={5}>
      <HStack spacing={6}>
        {r.failed ? (
          <Tag text="失败" tone="red" />
        ) : rejected ? (
          <Tag text="拒绝" tone="orange" />
        ) : r.method ? (
          <Tag text={r.method} tone="accent" mono />
        ) : null}
        <Text font={15} fontWeight="semibold" lineLimit={1} minScaleFactor={0.6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {r.remoteHost ?? r.URL}
        </Text>
        {clock ? (
          <Text font={11} fontDesign="rounded" monospacedDigit foregroundStyle="tertiaryLabel">{clock}</Text>
        ) : null}
      </HStack>
      <HStack spacing={8}>
        <Image systemName="arrow.triangle.branch" font={10} foregroundStyle="tertiaryLabel" />
        <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{r.policyName}</Text>
        <Spacer />
        {active ? (
          <HStack spacing={8}>
            <Text font={12} fontDesign="rounded" monospacedDigit foregroundStyle={TONES[DOWN_TONE].fg}>{`↓ ${formatSpeed(r.inCurrentSpeed ?? 0)}`}</Text>
            <Text font={12} fontDesign="rounded" monospacedDigit foregroundStyle={TONES[UP_TONE].fg}>{`↑ ${formatSpeed(r.outCurrentSpeed ?? 0)}`}</Text>
          </HStack>
        ) : (
          <Text font={12} fontDesign="rounded" monospacedDigit foregroundStyle="secondaryLabel">
            {formatBytes((r.inBytes ?? 0) + (r.outBytes ?? 0))}
          </Text>
        )}
      </HStack>
      {r.rule ? (
        <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel" lineLimit={1}>{r.rule}</Text>
      ) : null}
    </VStack>
  )
}

const DETAIL_REFRESH_MS = 2000

function RequestDetailView({
  r,
  active,
  onKilled,
}: {
  r: SurgeRequest
  active?: boolean
  onKilled?: () => void
}) {
  const config = useStoreSelector((s) => s.config)
  const [showKill, setShowKill] = useState(false)
  const [killMsg, setKillMsg] = useState<string | null>(null)
  // 活动连接详情跟随刷新，不再是进入时的静态快照；从活动列表消失即视为已结束
  const [live, setLive] = useState<SurgeRequest>(r)
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      getActiveRequests(config)
        .then((res) => {
          const found = res.requests.find((x) => x.id === r.id)
          if (found) {
            setLive(found)
          } else {
            setEnded(true)
            clearInterval(id)
          }
        })
        .catch(() => {})
    }, DETAIL_REFRESH_MS)
    return () => clearInterval(id)
  }, [config, r.id, active])

  const cur = active ? live : r
  const ongoing = Boolean(active) && !cur.completed && !ended
  const remoteIp = extractIpAddress(cur.remoteAddress) ?? extractIpAddress(cur.remoteHost)
  const geo = formatGeoSummary(useGeoIp(remoteIp).result)

  async function doKill() {
    try {
      await killRequest(config, r.id)
      setKillMsg("已终止该连接")
      onKilled?.()
    } catch (e) {
      setKillMsg(`终止失败：${String(e)}`)
    }
  }

  const statusText = cur.status ?? (cur.completed ? "已完成" : ended ? "已结束" : active ? "进行中" : undefined)

  return (
    <List
      navigationTitle="请求详情"
      navigationBarTitleDisplayMode="inline"
      {...LIST_STYLE}
      confirmationDialog={{
        isPresented: showKill,
        onChanged: setShowKill,
        title: "确认终止该连接？",
        actions: <Button title="终止" role="destructive" action={doKill} />,
      }}
    >
      <Section>
        <VStack alignment="leading" spacing={8} padding={{ vertical: 4 }}>
          <HStack spacing={6}>
            {cur.method ? <Tag text={cur.method} tone="accent" mono /> : null}
            {statusText ? <Tag text={statusText} tone={ongoing ? "green" : cur.failed ? "red" : "gray"} /> : null}
            <Spacer />
            <Text font={12} foregroundStyle="secondaryLabel" lineLimit={1}>{cur.policyName}</Text>
          </HStack>
          <Text font={17} fontWeight="semibold" lineLimit={2} minScaleFactor={0.7}>{cur.remoteHost ?? cur.URL}</Text>
          <Text font={12} fontDesign="monospaced" foregroundStyle="secondaryLabel">{cur.URL}</Text>
        </VStack>
      </Section>

      <Section header={<Text>概览</Text>}>
        <InfoRow label="策略" value={cur.policyName} />
        <InfoRow label="原始策略" value={cur.originalPolicyName !== cur.policyName ? cur.originalPolicyName : undefined} />
        <InfoRow label="匹配规则" value={cur.rule} mono />
        <InfoRow label="设备" value={cur.deviceName} />
        <InfoRow label="来源" value={cur.source} />
        <InfoRow label="远端" value={cur.remoteAddress ? `${cur.remoteAddress}${cur.remoteHost && cur.remoteHost !== cur.remoteAddress ? `（${cur.remoteHost}）` : ""}` : cur.remoteHost} />
        <InfoRow label="远端归属" value={geo} />
        <InfoRow label="本机" value={cur.localAddress} mono />
        <InfoRow label="接口" value={cur.interface} />
        <InfoRow label="开始时间" value={formatRequestDateTime(cur.startDate)} />
        {cur.completedDate ? <InfoRow label="完成时间" value={formatRequestDateTime(cur.completedDate)} /> : null}
      </Section>

      <Section header={<Text>流量</Text>}>
        <InfoRow label="下载总量" value={formatBytes(cur.inBytes ?? 0)} />
        <InfoRow label="上传总量" value={formatBytes(cur.outBytes ?? 0)} />
        {ongoing ? (
          <>
            <InfoRow label="实时下载" value={formatSpeed(cur.inCurrentSpeed ?? 0)} />
            <InfoRow label="实时上传" value={formatSpeed(cur.outCurrentSpeed ?? 0)} />
          </>
        ) : null}
        {cur.inMaxSpeed ? <InfoRow label="峰值下载" value={formatSpeed(cur.inMaxSpeed)} /> : null}
        {cur.outMaxSpeed ? <InfoRow label="峰值上传" value={formatSpeed(cur.outMaxSpeed)} /> : null}
      </Section>

      {cur.notes && cur.notes.length > 0 ? (
        <Section header={<Text>决策过程</Text>}>
          {cur.notes.map((n, i) => (
            <Text key={i} font={12} fontDesign="monospaced" lineLimit={3}>{n}</Text>
          ))}
        </Section>
      ) : null}

      {cur.timingRecords && cur.timingRecords.length > 0 ? (
        <Section header={<Text>耗时分解</Text>}>
          {cur.timingRecords.map((t, i) => (
            <HStack key={i}>
              <Text font={14}>{t.name}</Text>
              <Spacer />
              <Text font={14} fontDesign="rounded" monospacedDigit foregroundStyle="secondaryLabel">
                {t.durationInMillisecond < 1 ? "<1 ms" : `${Math.round(t.durationInMillisecond)} ms`}
              </Text>
            </HStack>
          ))}
        </Section>
      ) : null}

      {ongoing ? (
        <Section footer={killMsg ? <Text font={12}>{killMsg}</Text> : undefined}>
          <Button title="终止连接" role="destructive" systemImage="xmark.circle" action={() => setShowKill(true)} />
        </Section>
      ) : null}
    </List>
  )
}
