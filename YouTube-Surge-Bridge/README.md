# YouTube 去广告 + 翻译 共存方案（桥接补丁）

## 原理

Surge 规定：同一个请求**只会执行 profile 里第一条匹配的 response 脚本**。YouTube Enhance 和 DualSubs 都要改写 `youtubei.googleapis.com/youtubei/v1/player` 与 `get_watch` 的响应，所以只能活一个——这就是你调顺序时"翻译好了、去广告部分失效"的根因。

本方案用**一条脚本接管这两个接口**，在脚本内部依次做两件事：

1. 执行 YouTube Enhance 的 `response.js`，去掉广告字段（adPlacements / adSlots / 赞助卡片等）；
2. 把去广告后的 body 交给 DualSubs 的 `response.bundle.js`，注入双语字幕轨道。

两个子脚本按真实源码结构被"拦截式"调用：它们的 `$done(...)` 被替换成捕获函数，输出 body 串接后再交给下一个。去广告脚本是同步的，翻译脚本是异步的（在 `.finally()` 里回调），桥接脚本内部用 Promise 处理了顺序。

## 需要你做的（按顺序）

### 1. 托管桥接脚本
把 `youtube-bridge.js` 上传到任意可被 Surge 访问的地址，例如新建一个 GitHub Gist，复制它的 **raw 链接**。

> 如果你的网络无法直连 `raw.githubusercontent.com` / `github.com`，桥接脚本拉不到两个子脚本。此时把下面两个文件也下载托管，并修改 `youtube-bridge.js` 顶部的 `AD_URL` / `DS_URL`：
> - `https://raw.githubusercontent.com/gholts/surge/main/scripts/youtube/response.js`
> - `https://github.com/DualSubs/YouTube/releases/download/v1.6.0/response.bundle.js`

### 2. 改桥接模块的脚本地址
打开 `youtube-bridge.sgmodule`，把这一行里的 `script-path=替换为你的桥接脚本URL` 换成第 1 步拿到的 raw 链接。

### 3. 替换两个原模块
- 用 `youtube-enhance-patched.sgmodule` 替换原来的 YouTube Enhance；
- 用 `DualSubs.YouTube-patched.sgmodule` 替换原来的 DualSubs YouTube。

两个改造版只是**移除了各自冲突的 player/get_watch response 脚本**，其余规则（ad-break 拦截、initplayback、pagead 重写、timedtext 字幕、Music 歌词、偏好面板等）全部原样保留。

### 4. 启用顺序
三个模块都启用即可。桥接模块没有前后顺序要求——它现在是这两个接口上唯一的 response 脚本。

### 5. 核对参数（重要）
桥接脚本顶部写死了两组参数，**必须和你实际用的模块参数一致**，否则功能会不符合预期：

```js
const AD_ARG = '{"blockUpload":true,"blockShorts":false,...}';  // 对应 YouTube Enhance 的开关
const DS_ARG = 'Type="Official"&Types="Translate"&...';        // 对应 DualSubs 的字幕设置
```

如果你在 Surge 里改过这些模块的开关，记得同步改桥接脚本里的值。

### 6. 完全重启
关闭 Surge → 重开 → 强制退出 YouTube App → 重新打开。第一次会下载两个子脚本（约 145 KB）并缓存，稍慢属正常。

## 怎么验证成功

打开 Surge 的请求记录，播放一个带广告的外区视频：

- 看 `youtubei.googleapis.com/.../player` 的请求，若被脚本处理过（有脚本执行的 note），说明桥接生效；
- 视频里**没有广告**，且**字幕选项里出现翻译字幕**（Official/Translate 两行），即两者都工作；
- 若只有翻译没有去广告，或反之，多半是第 5 步参数没对上，或子脚本没拉到（看 Surge 日志里 `[yt-bridge]` 开头的输出）。

## 已知风险 / 回退

- **这是实验性方案**：我没有 iOS/Surge 环境实测，是按两个脚本的真实源码结构设计的。protobuf 字段串接能否 100% 保留双方改动，需要用你的设备验证。
- **脚本更新会失效**：DualSubs 或 YouTube Enhance 升级后，子脚本结构可能变化。届时把 `CACHE_KEY` 里的 `v1` 改成 `v2` 刷新缓存；若仍失效，需重新核对脚本结构。
- **超时**：桥接脚本 `timeout=15`，翻译脚本要请求翻译 API，网络慢时可能超时。超时会走 `catch` 放行原响应（即当前请求两者都不生效，但不影响播放）。
- **回退**：直接停用桥接模块、恢复两个原模块即可回到之前的状态。

## 文件清单

| 文件 | 用途 |
|---|---|
| `youtube-bridge.js` | 桥接脚本，需自行托管拿 raw URL |
| `youtube-bridge.sgmodule` | 桥接模块，需填入上面的 raw URL |
| `youtube-enhance-patched.sgmodule` | 去广告模块改造版 |
| `DualSubs.YouTube-patched.sgmodule` | 翻译模块改造版 |
