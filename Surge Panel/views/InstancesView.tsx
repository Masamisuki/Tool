// 设置 → 实例：添加 / 编辑 / 测试连通 / 删除
import {
  Button,
  HStack,
  List,
  Picker,
  Section,
  SecureField,
  Text,
  TextField,
  useState,
  VStack,
} from "scripting"
import { InstanceList } from "../components/InstanceList"
import { BARE_ROW, IconBadge, LIST_STYLE, ListRow, Tag } from "../components/Kit"
import { endpointScope, validateEndpoint } from "../lib/connection"
import {
  defaultInstance,
  getInstanceKey,
  type SurgeInstance,
} from "../lib/instances"
import {
  addInstance,
  deleteInstance,
  switchInstance,
  updateInstance,
} from "../lib/store"
import {
  getEnvironment,
  probeOutbound,
  surgeApiErrorKind,
  surgeApiErrorMessage,
  type SurgeApiErrorKind,
} from "../lib/surgeApi"
import { cardBackground, connectionErrorHint, IS_GLASS, roundedShape, TONES, UI, type Tone } from "../lib/ui"

const HTTP_API_DOC = "https://manual.nssurge.com/tools/http-api.html"

function securityNote(protocol: "http" | "https", host: string): string {
  if (host.trim().toLowerCase().endsWith(".sgponte")) {
    return "Surge 官方远程管理指南未将 HTTP API 列为 Ponte 支持能力；本面板不保证 .sgponte 连接可用。"
  }
  const scope = endpointScope(host)
  if (scope === "local") {
    return protocol === "https"
      ? "本机 HTTPS 仍需安装并信任 Surge MITM CA。"
      : "本机回环连接不会离开当前设备。"
  }
  if (scope === "public") {
    return "疑似公网地址。不要将 Surge HTTP API 端口直接映射到互联网；请只在可信私网或受控隧道中使用。"
  }
  return protocol === "https"
    ? "局域网 HTTPS 需在本机安装并信任 Surge MITM CA。"
    : "局域网 HTTP 为明文传输，只应在可信网络中使用。"
}

export function InstancesView({ startAdding = false, onClose }: { startAdding?: boolean; onClose?: () => void }) {
  const [editing, setEditing] = useState<SurgeInstance | null>(null)
  const [adding, setAdding] = useState(startAdding)

  if (adding) {
    return (
      <InstanceEditor
        initial={defaultInstance()}
        isNew
        onDone={() => setAdding(false)}
      />
    )
  }
  if (editing) {
    return (
      <InstanceEditor
        initial={editing}
        isNew={false}
        onDone={() => setEditing(null)}
      />
    )
  }
  return (
    <InstanceList
      onAdd={() => setAdding(true)}
      onEdit={(inst) => setEditing(inst)}
      onClose={onClose}
    />
  )
}

export function InstanceEditor({
  initial,
  isNew,
  onDone,
}: {
  initial: SurgeInstance
  isNew: boolean
  onDone?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [protocol, setProtocol] = useState<"http" | "https">(initial.protocol)
  const [host, setHost] = useState(initial.host)
  const [port, setPort] = useState(initial.port)
  const [key, setKey] = useState(getInstanceKey(initial.id))
  const [probeMeta, setProbeMeta] = useState<Partial<SurgeInstance>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const [msgKind, setMsgKind] = useState<SurgeApiErrorKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<"delete" | "publicSave" | "publicTest" | null>(null)

  function draft(): SurgeInstance {
    return {
      ...initial,
      ...probeMeta,
      name: name.trim() || host.trim() || "未命名",
      protocol,
      host: host.trim(),
      port: port.trim(),
    }
  }

  function testingSavedConnection(): boolean {
    return (
      !isNew &&
      protocol === initial.protocol &&
      host.trim() === initial.host &&
      port.trim() === initial.port &&
      key === getInstanceKey(initial.id)
    )
  }

  function clearProbe() {
    setMsg(null)
    setMsgKind(null)
    setProbeMeta({
      deviceName: undefined,
      version: undefined,
      build: undefined,
      lastSeenAt: undefined,
      lastLatencyMs: undefined,
      lastError: undefined,
      lastErrorAt: undefined,
    })
  }

  async function runTest() {
    const validation = validateEndpoint(host, port, key)
    if (validation) {
      setMsg(validation)
      setMsgKind("validation")
      return
    }
    setBusy(true)
    setMsg(null)
    setMsgKind(null)
    try {
      const cfg = { protocol, host: host.trim(), port: port.trim(), key }
      const probe = await probeOutbound(cfg)
      let deviceName: string | undefined
      try {
        const env = await getEnvironment(cfg)
        deviceName = env.deviceName
      } catch {
        // environment 在部分设备不可用
      }
      const bits = [
        "连通正常",
        `${probe.latencyMs} ms`,
        probe.mode ? `出站 ${probe.mode}` : null,
        probe.version ? `v${probe.version}` : null,
        deviceName,
      ].filter(Boolean)
      setMsg(bits.join(" · "))
      const health: Partial<SurgeInstance> = {
        deviceName,
        version: probe.version,
        build: probe.build,
        lastSeenAt: Date.now(),
        lastLatencyMs: probe.latencyMs,
        lastError: undefined,
        lastErrorAt: undefined,
      }
      setProbeMeta(health)
      if (testingSavedConnection()) updateInstance(initial.id, health)
    } catch (e) {
      const kind = surgeApiErrorKind(e)
      const message = surgeApiErrorMessage(e)
      setMsg(`失败：${message}。${connectionErrorHint(kind)}`)
      setMsgKind(kind)
      const failed: Partial<SurgeInstance> = {
        lastError: message,
        lastErrorAt: Date.now(),
      }
      setProbeMeta(failed)
      if (testingSavedConnection()) updateInstance(initial.id, failed)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    const validation = validateEndpoint(host, port, key)
    if (validation) {
      setMsg(validation)
      setMsgKind("validation")
      return
    }
    if (endpointScope(host) === "public") {
      setPendingAction("publicTest")
      return
    }
    await runTest()
  }

  async function persist() {
    const inst = draft()
    try {
      if (isNew) {
        addInstance(inst, key)
        await switchInstance(inst.id)
      } else {
        updateInstance(inst.id, inst, key)
      }
      onDone?.()
    } catch (e) {
      setMsg(surgeApiErrorMessage(e))
      setMsgKind("validation")
    }
  }

  async function save() {
    const validation = validateEndpoint(host, port, key)
    if (validation) {
      setMsg(validation)
      setMsgKind("validation")
      return
    }
    if (endpointScope(host) === "public") {
      setPendingAction("publicSave")
      return
    }
    await persist()
  }

  async function remove() {
    try {
      await deleteInstance(initial.id)
      onDone?.()
    } catch (e) {
      setMsg(String(e))
    }
  }

  const localEndpoint = endpointScope(host) === "local"
  const setupPort = port.trim() || "6166"
  const setupSnippet =
    `[General]\nhttp-api = YOUR_KEY@${localEndpoint ? "127.0.0.1" : "0.0.0.0"}:${setupPort}` +
    `\nhttp-api-tls = ${protocol === "https" ? "true" : "false"}`

  const scope = endpointScope(host)
  const scopeLabel = scope === "local" ? "本机" : scope === "lan" ? "局域网" : host.trim() ? "外部地址" : "未填写"
  const probeOk = Boolean(probeMeta.lastSeenAt) && !msgKind
  const presetLocal = host.trim() === "127.0.0.1"

  return (
    <List
      {...LIST_STYLE}
      navigationTitle={isNew ? "添加实例" : "编辑实例"}
      navigationBarTitleDisplayMode="inline"
      confirmationDialog={{
        isPresented: pendingAction !== null,
        onChanged: (shown: boolean) => {
          if (!shown) setPendingAction(null)
        },
        title:
          pendingAction === "delete"
            ? "删除此实例？"
            : pendingAction === "publicTest"
              ? "连接疑似公网地址？"
              : "保存疑似公网地址？",
        message: (
          <Text>
            {pendingAction === "delete"
              ? "不会停止远端 Surge，只从面板里移除这条连接。"
              : "官方不建议将管理端口暴露到互联网。仅当此地址实际位于可信私网或受控隧道中时继续。"}
          </Text>
        ),
        actions: (
          pendingAction === "delete"
            ? <Button title="删除" role="destructive" action={() => { setPendingAction(null); void remove() }} />
            : pendingAction === "publicTest"
              ? <Button title="仍然测试" role="confirm" action={() => { setPendingAction(null); void runTest() }} />
              : <Button title="仍然保存" role="confirm" action={() => { setPendingAction(null); void persist() }} />
        ),
      }}
    >
      <Section>
        <VStack {...BARE_ROW} alignment="leading" spacing={12}>
          <HStack spacing={10}>
            <PresetTile
              icon="iphone"
              title="本机 Surge"
              subtitle="127.0.0.1:6166"
              tone="accent"
              selected={presetLocal}
              onTap={() => {
                clearProbe()
                setName(!name.trim() || name === "本机" || name === "网关" ? "本机" : name)
                setProtocol("http")
                setHost("127.0.0.1")
                setPort("6166")
              }}
            />
            <PresetTile
              icon="wifi.router"
              title="局域网网关"
              subtitle="填写网关 IP"
              tone="teal"
              selected={!presetLocal && scope === "lan"}
              onTap={() => {
                clearProbe()
                setName(!name.trim() || name === "本机" || name === "网关" ? "网关" : name)
                setProtocol("http")
                setHost("")
                setPort("6166")
              }}
            />
          </HStack>
          <Text font={12} foregroundStyle="secondaryLabel">
            预设只填写面板连接地址；Surge 侧监听配置见下方说明。
          </Text>
        </VStack>
      </Section>
      <Section header={<Text>连接</Text>}>
        <TextField label={<Text>名称</Text>} value={name} onChanged={setName} prompt="本机 / 网关" />
        <Picker
          title="协议"
          pickerStyle="segmented"
          value={protocol}
          onChanged={(v: string) => {
            clearProbe()
            setProtocol(v as "http" | "https")
          }}
        >
          <Text tag="http">http</Text>
          <Text tag="https">https</Text>
        </Picker>
        <TextField
          label={<Text>主机</Text>}
          value={host}
          onChanged={(value: string) => {
            clearProbe()
            setHost(value)
          }}
          prompt="127.0.0.1"
        />
        <TextField
          label={<Text>端口</Text>}
          value={port}
          onChanged={(value: string) => {
            clearProbe()
            setPort(value)
          }}
          prompt="6166"
        />
        <SecureField
          label={<Text>API Key</Text>}
          value={key}
          onChanged={(value: string) => {
            clearProbe()
            setKey(value)
          }}
          prompt="X-Key"
        />
      </Section>
      <Section>
        <VStack {...BARE_ROW} alignment="leading" spacing={12}>
          <HStack spacing={10}>
            <IconBadge
              icon={msgKind ? "xmark.octagon.fill" : probeOk ? "checkmark.seal.fill" : scope === "public" ? "exclamationmark.shield.fill" : "shield.lefthalf.filled"}
              tone={msgKind ? "red" : probeOk ? "green" : scope === "public" ? "orange" : "blue"}
              size={34}
            />
            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <HStack spacing={6}>
                <Text font={15} fontWeight="semibold">{msgKind ? "连接失败" : probeOk ? "连通正常" : "连接检查"}</Text>
                <Tag text={scopeLabel} tone={scope === "public" ? "orange" : "gray"} />
                <Tag text={protocol.toUpperCase()} tone="gray" mono />
              </HStack>
              <Text font={12} foregroundStyle={msgKind ? TONES.red.fg : "secondaryLabel"}>
                {msg ?? securityNote(protocol, host)}
              </Text>
            </VStack>
          </HStack>
          <HStack spacing={10}>
            <Button
              title={busy ? "测试中…" : "测试连通"}
              systemImage="antenna.radiowaves.left.and.right"
              buttonStyle="bordered"
              disabled={busy}
              frame={{ maxWidth: "infinity" }}
              action={() => { void test() }}
            />
            <Button
              title="保存"
              systemImage="checkmark"
              buttonStyle={IS_GLASS ? "glassProminent" : "borderedProminent"}
              frame={{ maxWidth: "infinity" }}
              action={() => { void save() }}
            />
          </HStack>
        </VStack>
      </Section>
      <Section
        header={<Text>Surge 侧配置</Text>}
        footer={
          localEndpoint ? undefined : (
            <Text font={13}>面板主机应填写 Surge 设备的实际局域网 IP，而不是 0.0.0.0。</Text>
          )
        }
      >
        <Text font={12} fontDesign="monospaced" padding={{ vertical: 4 }}>
          {setupSnippet}
        </Text>
        {protocol === "https" ? (
          <Text font={13} foregroundStyle="secondaryLabel">
            HTTPS 需先配置 MITM CA，将 CA 安装到本机并在系统设置中设为信任，再把 http-api-tls 改为 true。
          </Text>
        ) : null}
        <Button action={() => { void Safari.present(HTTP_API_DOC, false) }}>
          <ListRow icon="safari" tone="blue" title="Surge HTTP API 官方说明" titleColor="label" />
        </Button>
      </Section>
      {!isNew ? (
        <Section>
          <Button action={() => setPendingAction("delete")}>
            <ListRow icon="trash.fill" tone="red" title="删除实例" titleColor="systemRed" />
          </Button>
        </Section>
      ) : null}
      {onDone ? (
        <Section>
          <Button action={onDone}>
            <ListRow icon="chevron.left" tone="gray" title="返回列表" titleColor="label" />
          </Button>
        </Section>
      ) : null}
    </List>
  )
}

function PresetTile({
  icon,
  title,
  subtitle,
  tone,
  selected,
  onTap,
}: {
  icon: string
  title: string
  subtitle: string
  tone: Tone
  selected: boolean
  onTap: () => void
}) {
  return (
    <VStack
      alignment="leading"
      spacing={8}
      padding={14}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={cardBackground(UI.tileRadius, selected ? TONES[tone].soft : UI.cardBg)}
      contentShape={roundedShape(UI.tileRadius)}
      onTapGesture={onTap}
    >
      <IconBadge icon={icon} tone={tone} size={30} filled={selected} />
      <VStack alignment="leading" spacing={1}>
        <Text font={15} fontWeight="semibold">{title}</Text>
        <Text font={11} fontDesign="monospaced" foregroundStyle="secondaryLabel">{subtitle}</Text>
      </VStack>
    </VStack>
  )
}
