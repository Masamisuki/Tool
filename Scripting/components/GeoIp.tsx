// GeoIP 归属（/v1/geoip，iOS 5.23+ / Mac 6.10+）：连接详情、DNS 记录与查询工具共用
import { Text, useEffect, useState } from "scripting"
import { isGeoIpUnsupported, lookupGeoIpCached, surgeApiErrorMessage, type GeoIpResult } from "../lib/surgeApi"
import { countryFlag, countryName, formatDate, formatGeoSummary, isPublicIp } from "../lib/metrics"
import { useStoreSelector } from "../lib/store"
import { InfoRow } from "./Kit"

/** 只查公网地址；不支持的 Surge 版本静默返回 null，不打扰原有页面 */
export function useGeoIp(ip: string | null): { result: GeoIpResult | null; error: string | null } {
  const config = useStoreSelector((s) => s.config)
  const [state, setState] = useState<{ result: GeoIpResult | null; error: string | null }>({ result: null, error: null })

  useEffect(() => {
    setState({ result: null, error: null })
    if (!ip || !isPublicIp(ip) || isGeoIpUnsupported(config)) return
    let cancelled = false
    lookupGeoIpCached(config, ip)
      .then((result) => {
        if (!cancelled) setState({ result, error: null })
      })
      .catch((e) => {
        if (!cancelled) setState({ result: null, error: surgeApiErrorMessage(e) })
      })
    return () => {
      cancelled = true
    }
  }, [config, ip])

  return state
}

export function GeoIpInline({ ip }: { ip: string }) {
  const { result } = useGeoIp(ip)
  const text = formatGeoSummary(result)
  if (!text) return null
  return <Text font={11} foregroundStyle="secondaryLabel" lineLimit={1}>{text}</Text>
}

export function geoCountryText(code: string | null | undefined): string | null {
  if (!code) return null
  const name = countryName(code)
  const flag = countryFlag(code)
  return `${flag ? `${flag} ` : ""}${name}${name !== code.toUpperCase() ? `（${code.toUpperCase()}）` : ""}`
}

export function GeoIpRows({ result }: { result: GeoIpResult }) {
  return (
    <>
      <InfoRow label="国家 / 地区" value={geoCountryText(result.country) ?? "未知"} />
      <InfoRow label="ASN" value={result.asn != null ? `AS${result.asn}` : "未知"} mono />
      <InfoRow label="组织" value={result.organization ?? "未知"} />
    </>
  )
}

export function geoDbDatesText(result: GeoIpResult): string | null {
  const parts = [
    formatDate(result["geoip-db-date"]) ? `GeoIP 库 ${formatDate(result["geoip-db-date"])}` : null,
    formatDate(result["asn-db-date"]) ? `ASN 库 ${formatDate(result["asn-db-date"])}` : null,
  ].filter((x): x is string => Boolean(x))
  return parts.length > 0 ? parts.join(" · ") : null
}
