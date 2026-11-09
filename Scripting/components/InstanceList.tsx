// 实例切换列表（仪表盘 sheet / 设置入口共用）
import {
  Button,
  HStack,
  Image,
  List,
  Section,
  Text,
  VStack,
} from "scripting"
import { endpointScope } from "../lib/connection"
import { getCredentialWarning, instanceSubtitle, type SurgeInstance } from "../lib/instances"
import { switchInstance, useStoreSelector } from "../lib/store"
import { TONES } from "../lib/ui"
import { IconBadge, LIST_STYLE, ListRow, Tag } from "./Kit"

function scopeIcon(host: string): string {
  const scope = endpointScope(host)
  return scope === "local" ? "iphone" : scope === "lan" ? "wifi.router" : "globe"
}

function instanceHealth(inst: SurgeInstance): { text: string; failed: boolean } {
  const scope = endpointScope(inst.host)
  const parts = [
    inst.protocol.toUpperCase(),
    scope === "local" ? "本机" : scope === "lan" ? "局域网" : "外部地址",
  ]
  const failed = Boolean(inst.lastError && (inst.lastErrorAt ?? 0) >= (inst.lastSeenAt ?? 0))
  if (failed) parts.push(`失败：${inst.lastError}`)
  else if (inst.lastSeenAt) {
    if (inst.lastLatencyMs !== undefined) parts.push(`${inst.lastLatencyMs} ms`)
    parts.push(`最近 ${new Date(inst.lastSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
  } else parts.push("尚未测试")
  return { text: parts.join(" · "), failed }
}

export function InstanceList({
  onAdd,
  onEdit,
  onClose,
}: {
  onAdd?: () => void
  onEdit?: (inst: SurgeInstance) => void
  /** 以 sheet 呈现时提供「完成」按钮 */
  onClose?: () => void
}) {
  const credentialWarning = getCredentialWarning()
  const { instances, activeId } = useStoreSelector((s) => ({
    instances: s.instances,
    activeId: s.activeId,
  }))

  return (
    <List
      {...LIST_STYLE}
      navigationTitle="实例"
      navigationBarTitleDisplayMode="inline"
      toolbar={onClose ? { confirmationAction: <Button title="完成" action={onClose} /> } : undefined}
    >
      <Section
        header={<Text>{instances.length > 0 ? `${instances.length} 个实例` : "实例"}</Text>}
        footer={<Text font={13}>一次只连接一个 Surge HTTP API。点按切换，不会重新打开面板。</Text>}
      >
        {instances.length === 0 ? (
          <Text font={15} foregroundStyle="secondaryLabel">
            还没有实例。添加本机或网关的 HTTP API 后才会连接。
          </Text>
        ) : (
          instances.map((inst) => {
            const active = inst.id === activeId
            const health = instanceHealth(inst)
            return (
              <HStack
                key={inst.id}
                spacing={12}
                padding={{ vertical: 4 }}
                contentShape="rect"
                onTapGesture={() => {
                  void switchInstance(inst.id)
                }}
              >
                <IconBadge icon={scopeIcon(inst.host)} tone={active ? "accent" : "gray"} size={38} filled={active} />
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <HStack spacing={6}>
                    <Text font={16} fontWeight="semibold" lineLimit={1}>{inst.name}</Text>
                    {active ? <Tag text="当前" tone="accent" /> : null}
                  </HStack>
                  <Text font={12} fontDesign="monospaced" foregroundStyle="secondaryLabel" lineLimit={1}>
                    {instanceSubtitle(inst)}
                  </Text>
                  <Text
                    font={11}
                    foregroundStyle={health.failed ? TONES.red.fg : "tertiaryLabel"}
                    lineLimit={1}
                  >
                    {health.text}
                  </Text>
                </VStack>
                {onEdit ? (
                  <Button buttonStyle="borderless" action={() => onEdit(inst)}>
                    <Image systemName="slider.horizontal.3" font={16} foregroundStyle="secondaryLabel" />
                  </Button>
                ) : null}
                <Image
                  systemName={active ? "checkmark.circle.fill" : "circle"}
                  foregroundStyle={active ? TONES.accent.fg : "tertiaryLabel"}
                  font={20}
                />
              </HStack>
            )
          })
        )}
      </Section>
      {onAdd ? (
        <Section>
          <Button action={onAdd}>
            <ListRow icon="plus" tone="green" title="添加实例" titleColor="label" />
          </Button>
        </Section>
      ) : null}
      {credentialWarning ? (
        <Section>
          <HStack spacing={10}>
            <IconBadge icon="exclamationmark.triangle.fill" tone="red" />
            <Text font={13} foregroundStyle={TONES.red.fg}>{credentialWarning}</Text>
          </HStack>
        </Section>
      ) : null}
    </List>
  )
}
