// 设计组件：卡片、图标徽章、状态胶囊、指标块、主卡片、芯片栏、设置行
import {
  HStack,
  Image,
  Rectangle,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  type Color,
} from "scripting"
import { cardBackground, controlSurface, HERO_GRADIENT, HERO_SHADOW, PAGE_BACKDROP, roundedShape, TONES, UI, type Tone } from "../lib/ui"

export function Card({
  children,
  spacing = UI.cardSpacing,
  padding = UI.cardPadding,
  tone,
  onTap,
}: {
  children: any
  spacing?: number
  padding?: number
  tone?: Tone
  onTap?: () => void
}) {
  return (
    <VStack
      alignment="leading"
      spacing={spacing}
      padding={padding}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={cardBackground(UI.cardRadius, tone ? TONES[tone].soft : UI.cardBg)}
      contentShape={roundedShape()}
      onTapGesture={onTap}
    >
      {children}
    </VStack>
  )
}

export function HeroCard({ children, onTap }: { children: any; onTap?: () => void }) {
  return (
    <VStack
      alignment="leading"
      spacing={14}
      padding={18}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ style: HERO_GRADIENT, shape: roundedShape(26) }}
      shadow={HERO_SHADOW}
      foregroundStyle="white"
      contentShape={roundedShape(26)}
      onTapGesture={onTap}
    >
      {children}
    </VStack>
  )
}

export function IconBadge({
  icon,
  tone = "accent",
  size = 30,
  filled = false,
}: {
  icon: string
  tone?: Tone
  size?: number
  filled?: boolean
}) {
  const t = TONES[tone]
  return (
    <Image
      systemName={icon}
      font={Math.round(size * 0.47)}
      symbolRenderingMode="hierarchical"
      foregroundStyle={filled ? "white" : t.fg}
      frame={{ width: size, height: size }}
      background={{ style: filled ? t.fg : t.soft, shape: roundedShape(Math.round(size * 0.3)) }}
    />
  )
}

export type StatusKind = "ok" | "warn" | "error" | "idle" | "busy"

const STATUS_TONE: Record<StatusKind, Tone> = {
  ok: "green",
  warn: "orange",
  error: "red",
  idle: "gray",
  busy: "accent",
}

export function StatusPill({ kind, label, compact = false }: { kind: StatusKind; label: string; compact?: boolean }) {
  const t = TONES[STATUS_TONE[kind]]
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: compact ? 8 : 10, vertical: compact ? 3 : 5 }}
      background={{ style: t.soft, shape: "capsule" }}
    >
      <Image systemName="circle.fill" font={compact ? 6 : 7} foregroundStyle={t.fg} />
      <Text font={compact ? 11 : 12} fontWeight="semibold" foregroundStyle={t.fg} lineLimit={1}>
        {label}
      </Text>
    </HStack>
  )
}

export function Tag({ text, tone = "gray", mono = false }: { text: string; tone?: Tone; mono?: boolean }) {
  const t = TONES[tone]
  return (
    <Text
      font={10}
      fontWeight="bold"
      fontDesign={mono ? "monospaced" : "rounded"}
      foregroundStyle={t.fg}
      lineLimit={1}
      padding={{ horizontal: 6, vertical: 2 }}
      background={{ style: t.soft, shape: roundedShape(5) }}
    >
      {text}
    </Text>
  )
}

export function SectionHeader({
  title,
  caption,
  actionTitle,
  onAction,
}: {
  title: string
  caption?: string
  actionTitle?: string
  onAction?: () => void
}) {
  return (
    <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
      <Text font={UI.titleFont} fontWeight="semibold">{title}</Text>
      <Spacer />
      {actionTitle && onAction ? (
        <HStack spacing={3} onTapGesture={onAction} contentShape="rect">
          <Text font={13} fontWeight="medium" foregroundStyle={TONES.accent.fg}>{actionTitle}</Text>
          <Image systemName="chevron.right" font={10} foregroundStyle={TONES.accent.fg} />
        </HStack>
      ) : caption ? (
        <Text font={UI.captionFont} foregroundStyle="secondaryLabel" lineLimit={1}>{caption}</Text>
      ) : null}
    </HStack>
  )
}

/** 大号圆体数字 + 单位；数字变化时滚动过渡 */
export function ValueText({
  value,
  unit,
  size = UI.valueFont,
  color,
  unitColor,
}: {
  value: string
  unit?: string
  size?: number
  color?: Color
  unitColor?: Color
}) {
  return (
    <HStack spacing={3} alignment="lastTextBaseline">
      <Text
        font={size}
        fontWeight="semibold"
        fontDesign="rounded"
        monospacedDigit
        foregroundStyle={color}
        lineLimit={1}
        minScaleFactor={0.6}
        contentTransition="numericText"
        animation={{ animation: Animation.snappy(), value }}
      >
        {value}
      </Text>
      {unit ? (
        <Text
          font={Math.max(11, Math.round(size * 0.46))}
          fontWeight="medium"
          fontDesign="rounded"
          foregroundStyle={unitColor ?? "secondaryLabel"}
        >
          {unit}
        </Text>
      ) : null}
    </HStack>
  )
}

export function MetricTile({
  icon,
  tone,
  title,
  value,
  unit,
  subtitle,
  badge,
  onTap,
}: {
  icon: string
  tone: Tone
  title: string
  value: string
  unit?: string
  subtitle?: string
  badge?: string
  onTap?: () => void
}) {
  return (
    <VStack
      alignment="leading"
      spacing={10}
      padding={14}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={cardBackground(UI.tileRadius)}
      contentShape={roundedShape(UI.tileRadius)}
      onTapGesture={onTap}
    >
      <HStack spacing={8}>
        <IconBadge icon={icon} tone={tone} size={26} />
        <Text font={13} fontWeight="medium" foregroundStyle="secondaryLabel" lineLimit={1} minScaleFactor={0.8}>
          {title}
        </Text>
        <Spacer />
        {onTap ? <Image systemName="chevron.right" font={10} foregroundStyle="tertiaryLabel" /> : null}
      </HStack>
      <ValueText value={value} unit={unit} />
      {subtitle || badge ? (
        <Text
          font={UI.captionFont}
          fontWeight={badge ? "semibold" : "regular"}
          foregroundStyle={badge ? TONES.red.fg : "secondaryLabel"}
          lineLimit={1}
          minScaleFactor={0.7}
        >
          {badge ?? subtitle}
        </Text>
      ) : null}
    </VStack>
  )
}

export type ChipItem<T extends string> = { id: T; title: string; icon?: string; count?: number }

/** 横向胶囊分段；选中项实心强调色，其余为玻璃 / 材质 */
export function ChipBar<T extends string>({
  items,
  value,
  onChange,
}: {
  items: ChipItem<T>[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <ScrollView axes="horizontal" scrollIndicator="hidden">
      <HStack spacing={8} padding={{ horizontal: 2, vertical: 2 }}>
        {items.map((it) => {
          const on = it.id === value
          return (
            <HStack
              key={it.id}
              spacing={5}
              padding={{ horizontal: 14, vertical: 8 }}
              {...(on ? { background: { style: TONES.accent.fg, shape: "capsule" as const } } : controlSurface("capsule"))}
              contentShape="capsule"
              onTapGesture={() => onChange(it.id)}
              animation={{ animation: Animation.snappy(), value: on }}
            >
              {it.icon ? (
                <Image systemName={it.icon} font={12} foregroundStyle={on ? "white" : "secondaryLabel"} />
              ) : null}
              <Text font={14} fontWeight="semibold" foregroundStyle={on ? "white" : "label"}>
                {it.title}
              </Text>
              {it.count != null ? (
                <Text font={12} fontWeight="semibold" fontDesign="rounded" monospacedDigit foregroundStyle={on ? "rgba(255,255,255,0.8)" : "secondaryLabel"}>
                  {String(it.count)}
                </Text>
              ) : null}
            </HStack>
          )
        })}
      </HStack>
    </ScrollView>
  )
}

/** 设置式行：彩色图标方块 + 标题 / 副标题 + 右侧值（放进 NavigationLink / Toggle / Picker 的 label） */
export function ListRow({
  icon,
  tone = "accent",
  title,
  subtitle,
  value,
  titleColor,
}: {
  icon: string
  tone?: Tone
  title: string
  subtitle?: string
  value?: string
  titleColor?: Color
}) {
  return (
    <HStack spacing={12}>
      <IconBadge icon={icon} tone={tone} size={30} filled />
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={16} foregroundStyle={titleColor} lineLimit={1}>{title}</Text>
        {subtitle ? (
          <Text font={12} foregroundStyle="secondaryLabel" lineLimit={2}>{subtitle}</Text>
        ) : null}
      </VStack>
      {value ? (
        <Text font={15} foregroundStyle="secondaryLabel" lineLimit={1}>{value}</Text>
      ) : null}
    </HStack>
  )
}

/** 详情页键值行 */
export function InfoRow({ label, value, selectable, mono }: { label: string; value?: string | null; selectable?: boolean; mono?: boolean }) {
  if (value == null || value === "") return null
  return (
    <HStack spacing={12} alignment="firstTextBaseline">
      <Text font={14} foregroundStyle="secondaryLabel">{label}</Text>
      <Spacer />
      <Text
        font={14}
        fontDesign={mono ? "monospaced" : undefined}
        lineLimit={selectable ? undefined : 2}
        minScaleFactor={0.7}
        multilineTextAlignment="trailing"
      >
        {value}
      </Text>
    </HStack>
  )
}

/** 空态 / 加载态占位 */
export function EmptyState({ icon, title, message }: { icon: string; title: string; message?: string }) {
  return (
    <VStack spacing={8} padding={{ vertical: 22 }} frame={{ maxWidth: "infinity" }}>
      <Image systemName={icon} font={28} symbolRenderingMode="hierarchical" foregroundStyle="tertiaryLabel" />
      <Text font={15} fontWeight="semibold" foregroundStyle="secondaryLabel">{title}</Text>
      {message ? (
        <Text font={12} foregroundStyle="tertiaryLabel" multilineTextAlignment="center">{message}</Text>
      ) : null}
    </VStack>
  )
}

/** List 内去掉行背景与内边距，承载自绘卡片 / 芯片栏 */
export const BARE_ROW = {
  listRowBackground: <Rectangle fill="clear" />,
  listRowInsets: { top: 6, bottom: 6, leading: 16, trailing: 16 },
  listRowSeparator: "hidden" as const,
}

/** 页面背景：延伸到导航栏 / 标签栏下方，顶部不会出现与系统栏的色带接缝 */
export const PAGE_BG = <Rectangle fill="clear" background={PAGE_BACKDROP} ignoresSafeArea />

/** 列表页统一外观：inset 分组 + 淡色渐变背景 */
export const LIST_STYLE = {
  listStyle: "insetGroup" as const,
  scrollContentBackground: "hidden" as const,
  background: PAGE_BG,
}

export function SearchField({
  value,
  onChanged,
  prompt,
}: {
  value: string
  onChanged: (v: string) => void
  prompt: string
}) {
  return (
    <HStack spacing={8}>
      <Image systemName="magnifyingglass" font={14} foregroundStyle="tertiaryLabel" />
      <TextField title="搜索" value={value} onChanged={onChanged} prompt={prompt} />
      {value ? (
        <Image
          systemName="xmark.circle.fill"
          font={15}
          foregroundStyle="tertiaryLabel"
          onTapGesture={() => onChanged("")}
        />
      ) : null}
    </HStack>
  )
}

export function latencyTone(ms: number): Tone {
  return ms < 300 ? "green" : ms < 800 ? "orange" : "red"
}

