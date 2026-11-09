# Surge Panel for Scripting

一个运行在 iOS [Scripting](https://github.com/Scripting) App 上的 Surge 监控面板。通过 Surge HTTP API + Prometheus Metrics 提供四个标签（仪表盘 / 分流 / 活动 / 设置），支持多个实例切换，可挂到 Scripting 首页 Tab。3.0 起采用全新卡片式设计，iOS 26 上控件使用 Liquid Glass。

## 功能

- **多实例**：本机 / 网关等多个 HTTP API；仪表盘点实例名弹出菜单直接切换；设置里添加、编辑、测试连通、删除。一次只连接一个实例。
- **仪表盘**：连接状态、实时上下行主卡片（近 1 分钟速率图，1 秒采样，对齐 [YASD](https://github.com/geekdada/yasd)），MitM·捕获·重写·脚本快捷开关，内存 / 运行时长 / 活动连接 / DNS 指标块（点按直达详情），内存趋势，最新事件
- **分流**：策略组 | 规则。策略组按配置 `[Proxy Group]` 顺序；搜索；点按切换；延迟彩色胶囊；自动组测速与「最优」标记；`policy-path` 外部节点标为「外部」并可测速；嵌套组可再进入。规则可搜索并按类型着色
- **活动**：流量 | 连接 | DNS | 事件。流量含实时合计、分流占比、网卡 / 节点明细与排行；连接可在活动连接与最近请求间切换，可搜索排序、终止连接，详情显示远端 IP 的国家 / ASN / 组织；DNS 含静态 Host 与动态缓存、刷新与延迟测试、IP 归属查询
- **设置**：实例卡片与连接状态；引擎（出站模式、全局策略、日志级别）；功能（功能开关、模块、外部资源、脚本、当前配置）；面板（刷新间隔、历史长度、隐藏地址）；更新说明；重载配置 / 清空历史 / 停止引擎

## 使用

1. **导入脚本**（任选其一）：
   - **一键导入**：[在 Scripting 中打开 Surge Panel](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fgithub.com%2Fbluenight91%2FScripting-Scripts%2Ftree%2Fmain%2FSurge%2520Panel%22%5D)
   - 在 Scripting 中填入本目录的 GitHub 链接：`https://github.com/bluenight91/Scripting-Scripts/tree/main/Surge%20Panel`
   - 或将整个 `Surge Panel` 目录放入 Scripting 的脚本目录
2. 按下方示例在 Surge 中开启 HTTP API
3. 首次打开不会自动连接。到仪表盘或「设置 → 实例」选择本机 / 局域网预设，填写地址和 Key，可先测试再保存
4. 可选：Scripting 设置 → Show Home Tab → 选择本脚本

更新记录见 [`changelog.md`](./changelog.md)。导入后若说明有变化会弹出更新说明。

## Surge 配置

HTTP API 的官方格式是 `key@address:port`，不存在单独的 `http-api-key` 配置项。

同一台 iPhone / iPad 上运行 Surge 与 Scripting：

```ini
[General]
http-api = YOUR_KEY@127.0.0.1:6166
http-api-tls = false
```

从 Scripting 连接同一可信局域网中的 Surge Mac 或网关：

```ini
[General]
http-api = YOUR_KEY@0.0.0.0:6166
http-api-tls = false
```

面板的「主机」应填写 Surge 设备的实际局域网 IP 或域名，不能填写监听地址 `0.0.0.0`。`6166` 是本项目沿用的示例端口，可与 Surge 中实际配置保持一致。

如需 HTTPS，先在 Surge 配置 MITM CA，将该 CA 安装到运行 Scripting 的设备并在系统设置中设为信任，然后设置：

```ini
http-api-tls = true
```

Scripting 的 `allowInsecureRequest` 只负责允许明文 HTTP，并不能跳过 HTTPS 证书验证。连接失败时，实例页会区分 Key、超时、拒绝连接、TLS 与协议不匹配，并给出对应检查项。

`/metrics` 仅 iOS 5.22+ / Mac 6.9+；商店版与 Mac 6.8 仍可用流量、策略和请求，只是没有内存与封禁指标。

外部资源（`/v1/external_resources`）与 IP 归属（`/v1/geoip`）对应 iOS 5.23 / Mac 6.10（TestFlight 5.102 即 5.23 RC）。面板不比较版本号，只看接口是否响应；不可用时外部资源页会显示 HTTP 状态与正在运行的引擎版本，便于确认是否需要重启引擎或连错了设备。连接与 DNS 详情在不可用时不显示归属，其它功能不受影响。

外部策略组（`policy-path`）里的节点需要 Surge TestFlight 新增的 `GET /v1/policies?include_external=true`：策略组详情会把这些节点标为「外部」，「全部测速」时按 identifier 经脚本 `$httpClient` 的 `policy` 选项逐个请求计时（需开启脚本功能，数值为完整 HTTP 耗时，与 Surge 基准测试口径不同）。旧版本 Surge 不返回该字段，策略组详情保持原样。

## 远程访问与安全

- Surge Panel 是 HTTP API 客户端，不是 External Controller。按 Surge 官方[远程管理指南](https://kb.nssurge.com/surge-knowledge-base/zh/guidelines/remote-management)，HTTP API 不具备 External Controller 的 Ponte、USB 与完整管理能力。
- 不要通过端口转发或 DMZ 把 HTTP API 直接暴露到互联网。局域网 HTTP 是明文传输，只应在可信网络中使用；异地场景请优先使用官方支持的远程管理方案。
- API Key 通过 `X-Key` 请求头发送，并按实例保存在 iOS Keychain；从 2.0.x 升级时会自动从旧 Storage 安全迁移。
- HTTPS 只有在正确安装并信任 CA 后才能验证服务器身份。面板不提供“忽略证书”开关。
- 若使用局域网地址，请确认 iOS「设置 → 隐私与安全性 → 本地网络」中已允许 Scripting。

## 技术要点

- 数据层：`lib/surgeApi.ts` 封装 HTTP API（GeoIP 结果按实例缓存在内存）；`lib/instances.ts` 多实例与迁移；`lib/store.ts` 当前实例的 metrics / 1Hz traffic
- 实时速率：`/v1/traffic` 1Hz、内存 60 点；折线 `monotone`、Y 轴从 0
- 首页：顶部分段 + 翻页；Scripting 浮层底栏可见，内容铺到屏幕底
- 不做：External Controller / Ponte / USB、Mac 设备管理、Surge 配置档切换、系统代理 / Enhanced Mode、MITM CA 下载

## License

MIT
