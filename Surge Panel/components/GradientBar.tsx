// 渐变进度条：排行（带名次与标签）或纯比例条
import {
  GeometryReader,
  gradient,
  HStack,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
  type Color,
} from "scripting"

export function GradientBar({
  label,
  valueText,
  rank,
  ratio,
  colors,
  track = "rgba(142,142,147,0.18)",
  height = 8,
}: {
  label?: string
  valueText?: string
  rank?: number
  ratio: number // 0 ~ 1
  colors: Color[]
  track?: Color
  height?: number
}) {
  const pct = Math.max(0, Math.min(1, ratio))
  const r = height / 2
  return (
    <VStack alignment="leading" spacing={6}>
      {label ? (
        <HStack spacing={8}>
          {rank != null ? (
            <Text font={12} fontWeight="bold" fontDesign="rounded" monospacedDigit foregroundStyle="tertiaryLabel" frame={{ width: 18, alignment: "leading" }}>
              {String(rank)}
            </Text>
          ) : null}
          <Text font={14} fontWeight="medium" lineLimit={1} minScaleFactor={0.7}>{label}</Text>
          <Spacer />
          {valueText ? (
            <Text font={13} fontDesign="rounded" monospacedDigit foregroundStyle="secondaryLabel">{valueText}</Text>
          ) : null}
        </HStack>
      ) : null}
      <GeometryReader>
        {(proxy: { size: { width: number } }) => (
          <ZStack alignment="leading" frame={{ width: proxy.size.width, height }}>
            <RoundedRectangle cornerRadius={r} style="continuous" fill={track} />
            {pct > 0 ? (
              <RoundedRectangle
                cornerRadius={r}
                style="continuous"
                fill={gradient("linear", { colors, startPoint: "leading", endPoint: "trailing" })}
                frame={{ width: Math.max(height, proxy.size.width * pct), height }}
              />
            ) : null}
          </ZStack>
        )}
      </GeometryReader>
    </VStack>
  )
}
