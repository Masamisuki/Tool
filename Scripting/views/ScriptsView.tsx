// 脚本管理：列出 Surge 配置的脚本，cron 脚本可手动触发
import {
  Button,
  HStack,
  List,
  NavigationLink,
  Picker,
  Section,
  Text,
  TextField,
  useEffect,
  useState,
  VStack,
} from "scripting"
import { evaluateScript, getScripts, runCronScript, type SurgeScript } from "../lib/surgeApi"
import { useStoreSelector } from "../lib/store"
import { EmptyState, IconBadge, LIST_STYLE, ListRow, Tag } from "../components/Kit"
import { IS_GLASS, TONES, type Tone } from "../lib/ui"

const TYPE_LABELS: Record<string, string> = {
  cron: "定时",
  generic: "通用",
  "http-request": "HTTP 请求",
  "http-response": "HTTP 响应",
  rule: "规则",
  dns: "DNS",
  event: "事件",
  tile: "卡片",
}

const TYPE_VISUALS: Record<string, { icon: string; tone: Tone }> = {
  cron: { icon: "clock.fill", tone: "orange" },
  generic: { icon: "curlybraces", tone: "purple" },
  "http-request": { icon: "arrow.up.doc.fill", tone: "blue" },
  "http-response": { icon: "arrow.down.doc.fill", tone: "teal" },
  rule: { icon: "list.bullet.indent", tone: "accent" },
  dns: { icon: "server.rack", tone: "green" },
  event: { icon: "bell.fill", tone: "pink" },
  tile: { icon: "square.grid.2x2.fill", tone: "yellow" },
}

function shortPath(p: string): string {
  if (p.length <= 50) return p
  try {
    const u = new URL(p)
    const segs = u.pathname.split("/").filter(Boolean)
    return `${u.host}/…/${segs[segs.length - 1] ?? ""}`
  } catch {
    return `…${p.slice(-45)}`
  }
}

export function ScriptsView() {
  const config = useStoreSelector((s) => s.config)
  const [scripts, setScripts] = useState<SurgeScript[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  useEffect(() => {
    getScripts(config)
      .then((r) => setScripts(r.scripts))
      .catch((e) => setError(String(e)))
  }, [config])

  async function runCron(name: string) {
    if (running) return
    setRunning(name)
    try {
      await runCronScript(config, name)
      setResults((m) => ({ ...m, [name]: "✓ 已触发执行" }))
    } catch (e) {
      setResults((m) => ({ ...m, [name]: `✗ ${String(e)}` }))
    } finally {
      setRunning(null)
    }
  }

  return (
    <List {...LIST_STYLE} navigationTitle="脚本">
      <Section>
        <NavigationLink destination={<ScriptEvaluateView />}>
          <ListRow icon="terminal.fill" tone="gray" title="调试执行" subtitle="在当前实例上运行一段脚本" />
        </NavigationLink>
      </Section>
      {error ? (
        <Section>
          <Text foregroundStyle={TONES.red.fg}>{error}</Text>
        </Section>
      ) : null}
      {scripts === null ? (
        error ? null : (
          <Section>
            <EmptyState icon="hourglass" title="加载中…" />
          </Section>
        )
      ) : scripts.length === 0 ? (
        <Section>
          <EmptyState icon="scroll" title="未配置任何脚本" message="在 Surge 配置的 [Script] 段添加后会显示在这里" />
        </Section>
      ) : (
        <Section
          header={<Text>{`${scripts.length} 个脚本`}</Text>}
          footer={<Text font={12}>定时脚本可手动触发。开关需在 Surge 配置中修改。</Text>}
        >
          {scripts.map((s) => {
            const visual = TYPE_VISUALS[s.type] ?? { icon: "doc.fill", tone: "gray" as Tone }
            const result = results[s.name]
            return (
              <HStack key={s.name} spacing={12} alignment="top" padding={{ vertical: 4 }}>
                <IconBadge icon={visual.icon} tone={s.enabled ? visual.tone : "gray"} size={32} />
                <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <HStack spacing={6}>
                    <Text font={15} fontWeight="semibold" lineLimit={1}>{s.name}</Text>
                    <Tag text={TYPE_LABELS[s.type] ?? s.type} tone={visual.tone} />
                    {s.enabled ? null : <Tag text="已停用" tone="gray" />}
                  </HStack>
                  <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel" lineLimit={1} minScaleFactor={0.7}>
                    {shortPath(s.path)}
                  </Text>
                  {s.type === "cron" && s.enabled ? (
                    <HStack spacing={8}>
                      <Button
                        title={running === s.name ? "执行中…" : "立即执行"}
                        systemImage="play.fill"
                        buttonStyle="bordered"
                        disabled={running !== null}
                        action={() => runCron(s.name)}
                      />
                      {result ? (
                        <Text
                          font={11}
                          foregroundStyle={result.startsWith("✓") ? TONES.green.fg : TONES.red.fg}
                          lineLimit={1}
                        >
                          {result}
                        </Text>
                      ) : null}
                    </HStack>
                  ) : null}
                </VStack>
              </HStack>
            )
          })}
        </Section>
      )}
    </List>
  )
}

function ScriptEvaluateView() {
  const config = useStoreSelector((s) => s.config)
  const [code, setCode] = useState('console.log("hello from Surge Panel")')
  const [mockType, setMockType] = useState("cron")
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const r = await evaluateScript(config, code, mockType, 5)
      setResult(typeof r === "string" ? r : JSON.stringify(r, null, 2) || "执行完成（无返回）")
    } catch (e) {
      setResult(`失败：${e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <List {...LIST_STYLE} navigationTitle="调试执行">
      <Section footer={<Text font={13}>POST /v1/scripting/evaluate。$trigger 为 http-api。</Text>}>
        <Picker title="类型" value={mockType} onChanged={setMockType}>
          <Text tag="cron">cron</Text>
          <Text tag="http-request">http-request</Text>
          <Text tag="http-response">http-response</Text>
          <Text tag="generic">generic</Text>
          <Text tag="event">event</Text>
          <Text tag="dns">dns</Text>
        </Picker>
        <TextField
          title="脚本"
          value={code}
          onChanged={setCode}
          prompt="script_text"
        />
        <Button
          title={busy ? "执行中…" : "执行"}
          systemImage="play.fill"
          buttonStyle={IS_GLASS ? "glassProminent" : "borderedProminent"}
          disabled={busy}
          action={() => { void run() }}
        />
      </Section>
      {result ? (
        <Section header={<Text>结果</Text>}>
          <Text font={12} fontDesign="monospaced" multilineTextAlignment="leading">{result}</Text>
        </Section>
      ) : null}
    </List>
  )
}
