// UIGlass / Animation 是 Scripting 的全局对象，不在 "scripting" 模块导出里，从模块导入会得到 undefined
import { Device, gradient, type Color, type DynamicShapeStyle } from "scripting"
import type { SurgeApiErrorKind } from "./surgeApi"

// 全屏与首页共用的设计令牌：4pt 网格、连续圆角、圆体等宽数字
export const UI = {
  pagePadding: 16,
  pageSpacing: 18,
  cardRadius: 22,
  tileRadius: 18,
  cardPadding: 16,
  cardSpacing: 12,
  heroFont: 38,
  valueFont: 24,
  unitFont: 13,
  captionFont: 12,
  bodyFont: 15,
  titleFont: 17,
  cardBg: "secondarySystemGroupedBackground" as Color,
} as const

export type Tone =
  | "accent"
  | "blue"
  | "teal"
  | "green"
  | "orange"
  | "red"
  | "purple"
  | "pink"
  | "yellow"
  | "gray"

// fg 用系统语义色随深浅色自适应；soft 为同色 16% 透明底，深浅色下都成立
export const TONES: Record<Tone, { fg: Color; soft: Color }> = {
  accent: { fg: "systemIndigo", soft: "rgba(94,92,230,0.16)" },
  blue: { fg: "systemBlue", soft: "rgba(10,132,255,0.16)" },
  teal: { fg: "systemTeal", soft: "rgba(48,176,199,0.18)" },
  green: { fg: "systemGreen", soft: "rgba(52,199,89,0.16)" },
  orange: { fg: "systemOrange", soft: "rgba(255,149,0,0.16)" },
  red: { fg: "systemRed", soft: "rgba(255,59,48,0.15)" },
  purple: { fg: "systemPurple", soft: "rgba(175,82,222,0.16)" },
  pink: { fg: "systemPink", soft: "rgba(255,45,85,0.15)" },
  yellow: { fg: "systemYellow", soft: "rgba(255,204,0,0.20)" },
  gray: { fg: "secondaryLabel", soft: "rgba(142,142,147,0.16)" },
}

export const DOWN_TONE: Tone = "blue"
export const UP_TONE: Tone = "teal"

export const IS_GLASS = Number.parseInt(Device.systemVersion, 10) >= 26

export function roundedShape(radius: number = UI.cardRadius) {
  return { type: "rect" as const, cornerRadius: radius, style: "continuous" as const }
}

export function cardBackground(radius: number = UI.cardRadius, style: Color = UI.cardBg) {
  return { style, shape: roundedShape(radius) }
}

/**
 * 浮在内容之上的控件（分段芯片、状态胶囊、工具按钮）用 Liquid Glass；
 * iOS 26 以下退回系统材质。卡片等内容层不用玻璃，保持可读性。
 */
export function controlSurface(shape: "capsule" | ReturnType<typeof roundedShape> = "capsule") {
  if (IS_GLASS) return { glassEffect: { glass: UIGlass.regular(), shape } }
  return { background: { style: "thinMaterial" as const, shape } }
}

// 页面背景：顶部一层很淡的靛蓝，向下过渡到分组背景色
export const PAGE_BACKDROP: DynamicShapeStyle = {
  light: gradient("linear", {
    colors: ["#E6E5FA", "#F2F2F7", "#F2F2F7"],
    startPoint: "top",
    endPoint: "bottom",
  }),
  dark: gradient("linear", {
    colors: ["#17162E", "#000000", "#000000"],
    startPoint: "top",
    endPoint: "bottom",
  }),
}

// 首屏主卡片渐变（白字），深浅色一致
export const HERO_GRADIENT = gradient("linear", {
  colors: ["#4B47D6", "#2F6BEA", "#1597C9"],
  startPoint: "topLeading",
  endPoint: "bottomTrailing",
})

export const HERO_SHADOW = { color: "rgba(47,80,220,0.28)" as Color, radius: 18, x: 0, y: 8 }

export const CONNECT_HINT = "请到「设置 → 实例」检查地址与 Key"
export const METRICS_HINT = "内存与封禁需 Surge iOS 5.22+ 或 Mac 6.9+（商店版 / Mac 6.8 尚无 /metrics）"

export function connectionErrorHint(kind: SurgeApiErrorKind | null | undefined): string {
  switch (kind) {
    case "auth":
      return "已暂停自动重试；修改 Key 或手动刷新后再连接"
    case "timeout":
      return "检查 Surge 监听地址、同一网络、防火墙与 Scripting 本地网络权限"
    case "refused":
      return "确认 Surge HTTP API 已开启且端口正确"
    case "tls":
      return "安装并信任 Surge MITM CA，确认访问地址与证书匹配"
    case "protocol":
      return "核对面板协议与 Surge 的 http-api-tls 设置"
    case "unsupported":
      return "更新 Surge，或确认当前平台支持该 HTTP API"
    case "validation":
      return "检查主机、端口与 API Key"
    default:
      return CONNECT_HINT
  }
}

export function connectErrorText(
  error: string,
  prefix = "连接错误",
  kind?: SurgeApiErrorKind | null
): string {
  return `${prefix}：${error}（${connectionErrorHint(kind)}）`
}
