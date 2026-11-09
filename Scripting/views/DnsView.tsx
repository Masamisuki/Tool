// 活动 → DNS：延迟测试、清除缓存、静态 Host 与动态缓存
import {
  Button,
  HStack,
  List,
  NavigationLink,
  Section,
  Spacer,
  Text,
  TextField,
  useState,
  VStack,
} from "scripting"
import {
  flushDns,
  getDns,
  lookupGeoIp,
  resetGeoIpSupport,
  surgeApiErrorKind,
  surgeApiErrorMessage,
  testDnsDelay,
  API_523_MIN_VERSION,
  type DnsEntry,
  type GeoIpResult,
} from "../lib/surgeApi"
import { formatRequestDateTime, isIpAddress, isPublicIp, surgeTimestampToMs } from "../lib/metrics"
import { GeoIpInline, GeoIpRows, geoDbDatesText } from "../components/GeoIp"
import { UnsupportedApiNotice } from "../components/ApiUnsupported"
import { useStoreSelector } from "../lib/store"
import { useTabAutoRefresh } from "../lib/liveCache"
import { connectErrorText, TONES } from "../lib/ui"
import { BARE_ROW, EmptyState, IconBadge, InfoRow, LIST_STYLE, SearchField, Tag } from "../components/Kit"
import { ActivityChips } from "../components/SegmentChips"
import { listTitle } from "./ConnectionsView"

export function DnsView() {
  const config = useStoreSelector((s) => s.config)
  const [cache, setCache] = useState<DnsEntry[] | null>(null)
  const [local, setLocal] = useState<DnsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showFlush, setShowFlush] = useState(false)
  const [flushed, setFlushed] = useState(false)
  const [testDomain, setTestDomain] = useState("www.apple.com")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [query, setQuery] = useState("")
  const [geoInput, setGeoInput] = useState("")
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoResult, setGeoResult] = useState<GeoIpResult | null>(null)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [geoUnsupported, setGeoUnsupported] = useState<unknown>(null)

  async function runGeoLookup() {
    const ip = geoInput.trim().replace(/^\[|\]$/g, "")
    if (!ip || geoBusy) return
    if (!isIpAddress(ip)) {
      setGeoResult(null)
      setGeoError("请输入有效的 IPv4 / IPv6 地址")
      return
    }
    setGeoBusy(true)
    setGeoError(null)
    setGeoUnsupported(null)
    try {
      setGeoResult(await lookupGeoIp(config, ip))
      resetGeoIpSupport(config)
    } catch (e) {
      setGeoResult(null)
      if (surgeApiErrorKind(e) === "unsupported") setGeoUnsupported(e)
      else setGeoError(`查询失败：${surgeApiErrorMessage(e)}`)
    } finally {
      setGeoBusy(false)
    }
  }

  async function runDnsTest() {
    const domain = testDomain.trim()
    if (!domain || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testDnsDelay(config, domain)
      setTestResult({ ok: true, text: `${domain} 解析延迟 ${Math.round((r?.delay ?? 0) * 1000)} ms` })
    } catch (e) {
      setTestResult({ ok: false, text: `测试失败：${String(e)}` })
    } finally {
      setTesting(false)
    }
  }

  async function load() {
    try {
      const r = await getDns(config)
      setCache(asDnsList(r.dnsCache))
      setLocal(asDnsList(r.local))
      setError(null)
      setFlushed(false)
    } catch (e) {
      setError(String(e))
    }
  }

  useTabAutoRefresh("activity", load)

  async function doFlush() {
    try {
      await flushDns(config)
      setFlushed(true)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  const shownLocal = local ? filterDns(local, query) : []
  const shownCache = cache ? filterDns(cache, query) : []

  return (
    <List
      navigationTitle={listTitle("活动")}
      refreshable={async () => { await load() }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      {...LIST_STYLE}
      confirmationDialog={{
        isPresented: showFlush,
        onChanged: setShowFlush,
        title: "清除全部 DNS 缓存？",
        actions: <Button title="清除" role="destructive" action={doFlush} />,
      }}
    >
      <Section>
        <VStack {...BARE_ROW}>
          <ActivityChips />
        </VStack>
      </Section>
      <Section>
        <SearchField value={query} onChanged={setQuery} prompt="域名 / 地址" />
      </Section>
      <Section
        header={<Text>工具</Text>}
        footer={
          testResult ? (
            <Text font={12} foregroundStyle={testResult.ok ? TONES.green.fg : TONES.red.fg}>{testResult.text}</Text>
          ) : flushed ? (
            <Text font={12} foregroundStyle={TONES.green.fg}>已清除并重新加载</Text>
          ) : undefined
        }
      >
        <HStack spacing={12}>
          <IconBadge icon="timer" tone="teal" size={30} filled />
          <TextField title="域名" value={testDomain} onChanged={setTestDomain} prompt="www.apple.com" />
          <Button title={testing ? "测试中…" : "测试"} buttonStyle="bordered" disabled={testing} action={runDnsTest} />
        </HStack>
        <Button role="destructive" action={() => setShowFlush(true)}>
          <HStack spacing={12}>
            <IconBadge icon="trash" tone="red" size={30} filled />
            <Text font={16} foregroundStyle={TONES.red.fg}>清除 DNS 缓存</Text>
          </HStack>
        </Button>
      </Section>
      <Section
        header={<Text>IP 归属</Text>}
        footer={
          geoError ? (
            <Text font={12} foregroundStyle={TONES.red.fg}>{geoError}</Text>
          ) : geoResult ? (
            <Text font={12}>{geoDbDatesText(geoResult) ?? "使用 Surge 内置 GeoIP / ASN 数据库"}</Text>
          ) : (
            <Text font={12}>{`与 GEOIP、IP-ASN 规则使用同一数据库（${API_523_MIN_VERSION}）。`}</Text>
          )
        }
      >
        <HStack spacing={12}>
          <IconBadge icon="mappin.and.ellipse" tone="purple" size={30} filled />
          <TextField title="IP" value={geoInput} onChanged={setGeoInput} prompt="1.1.1.1 / 2606:4700::1111" />
          <Button title={geoBusy ? "查询中…" : "查询"} buttonStyle="bordered" disabled={geoBusy || !geoInput.trim()} action={runGeoLookup} />
        </HStack>
        {geoResult ? (
          <>
            <InfoRow label="地址" value={geoResult.address} mono />
            <GeoIpRows result={geoResult} />
          </>
        ) : geoUnsupported ? (
          <UnsupportedApiNotice
            feature="IP 归属"
            endpoint={`GET /v1/geoip?ip=${geoInput.trim()}`}
            error={geoUnsupported}
            onRetry={runGeoLookup}
          />
        ) : null}
      </Section>
      {error ? (
        <Section>
          <Text font={14} foregroundStyle="systemRed">{connectErrorText(error, "加载失败")}</Text>
        </Section>
      ) : null}
      {cache === null ? (
        <Section>
          <EmptyState icon="hourglass" title="加载中…" />
        </Section>
      ) : shownLocal.length > 0 ? (
        <Section header={<Text>{`静态 Host · ${shownLocal.length}`}</Text>}>
          {shownLocal.map((e, i) => (
            <NavigationLink key={`local-${e.domain}-${i}`} destination={<DnsDetailView e={e} />}>
              <DnsRow e={e} isStatic />
            </NavigationLink>
          ))}
        </Section>
      ) : null}
      {cache === null ? null : (
        <Section
          header={<Text>{`动态缓存 · ${shownCache.length}`}</Text>}
          footer={<Text font={12}>点按条目查看解析结果、CNAME 链路与查询日志。静态 Host 来自配置 [Host]，动态缓存有上限约 200。</Text>}
        >
          {shownCache.length === 0 ? (
            <EmptyState icon="server.rack" title={query ? "无匹配缓存" : "暂无缓存"} />
          ) : (
            shownCache.map((e, i) => (
              <NavigationLink key={`cache-${e.domain}-${i}`} destination={<DnsDetailView e={e} />}>
                <DnsRow e={e} />
              </NavigationLink>
            ))
          )}
        </Section>
      )}
    </List>
  )
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.length > 0)
  if (typeof v === "string" && v.length > 0) return [v]
  return []
}

function asDnsList(v: unknown): DnsEntry[] {
  if (!Array.isArray(v)) return []
  return v.map((raw) => {
    const e = raw as DnsEntry
    const path = (e as { path?: unknown }).path
    return {
      ...e,
      domain: String(e.domain ?? ""),
      data: asStringList(e.data),
      logs: asStringList(e.logs),
      path: Array.isArray(path) ? asStringList(path).join(" → ") : e.path,
    }
  })
}

function filterDns(list: DnsEntry[], query: string): DnsEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (e) =>
      e.domain.toLowerCase().includes(q) ||
      asStringList(e.data).some((d) => d.toLowerCase().includes(q))
  )
}

function DnsRow({ e, isStatic = false }: { e: DnsEntry; isStatic?: boolean }) {
  const records = asStringList(e.data)
  const source = e.server ?? e.comment ?? ""
  return (
    <VStack alignment="leading" spacing={4}>
      <HStack spacing={6}>
        <Text font={15} fontWeight="medium" lineLimit={1} minScaleFactor={0.7} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {e.domain}
        </Text>
        {isStatic ? <Tag text="HOST" tone="accent" /> : null}
      </HStack>
      <HStack spacing={6}>
        <Text font={12} fontDesign="monospaced" foregroundStyle="secondaryLabel" lineLimit={1}>
          {records.length > 0 ? records.join("  ") : "—"}
        </Text>
        <Spacer />
        {source ? <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={1}>{source}</Text> : null}
      </HStack>
    </VStack>
  )
}

function DnsDetailView({ e }: { e: DnsEntry }) {
  const records = asStringList(e.data)
  const logs = asStringList(e.logs)
  const expireText = (() => {
    if (!e.expiresTime) return null
    const remainMin = Math.max(0, Math.round((surgeTimestampToMs(e.expiresTime) - Date.now()) / 60000))
    return formatRequestDateTime(e.expiresTime) + `（剩余约 ${remainMin} 分钟）`
  })()

  return (
    <List navigationTitle={e.domain} navigationBarTitleDisplayMode="inline" {...LIST_STYLE}>
      <Section header={<Text>解析结果</Text>}>
        {records.length > 0 ? (
          records.map((ip, i) => (
            <VStack key={i} alignment="leading" spacing={2}>
              <Text font={16} fontDesign="monospaced">{ip}</Text>
              {isIpAddress(ip) && isPublicIp(ip) ? <GeoIpInline ip={ip} /> : null}
            </VStack>
          ))
        ) : (
          <Text font={13} foregroundStyle="secondaryLabel">无解析记录</Text>
        )}
      </Section>

      <Section header={<Text>查询信息</Text>}>
        <InfoRow label="DNS 服务器" value={e.server ?? "系统默认"} />
        <InfoRow label="网络接口" value={e.interface || undefined} />
        <InfoRow
          label="查询耗时"
          value={e.timeCost != null ? `${Math.round(e.timeCost * 1000)} ms` : undefined}
        />
        <InfoRow label="过期时间" value={expireText} />
      </Section>

      {e.path ? (
        <Section header={<Text>CNAME 解析链路</Text>}>
          <Text font={12} fontDesign="monospaced">{e.path}</Text>
        </Section>
      ) : null}

      {logs.length > 0 ? (
        <Section header={<Text>查询日志</Text>}>
          {logs.map((log, i) => (
            <Text key={i} font={12} fontDesign="monospaced" lineLimit={4}>{log}</Text>
          ))}
        </Section>
      ) : null}
    </List>
  )
}
