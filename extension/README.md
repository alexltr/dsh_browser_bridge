# DSH 实时浏览器桥（浏览器扩展）

把当前标签页交给 DeepSeek Harness 分析：读页面元素、跑 JS、抓接口请求/控制台/WebSocket、录制操作生成请求脚本。

- 清单版本：MV3
- 支持：Chrome / Edge 116+
- 连接：`ws://127.0.0.1:51919/bridge`（可在「高级设置」改端口）
- 固定 ID：`hlfcjpadcahkpbdnhomoagoekopdmnfo`（由 `manifest.json` 的 `key` 决定）

## 安装

1. 打开 `edge://extensions`（或 `chrome://extensions`）。
2. 右上角打开「开发人员模式 / Developer mode」。
3. 「加载解压缩的扩展 / Load unpacked」→ 选择本目录 `extension/`。
4. 把图标固定到工具栏，点开即可看到连接状态。

> 更换 `manifest.json` 里的 `key` 会改变扩展 ID，需要同步修改 Host 插件的 `extensionIds` 配置。
>
> **升级到 0.2.0**：在 `edge://extensions` 找到本扩展，点「重新加载 / Reload」，然后重新授权标签页。
> 未重新加载时浏览器里仍是旧代码（状态栏会显示 v0.1.0）。

## 使用

1. 先在 DSH 里安装并启用 `dsh-browser-bridge` 插件（默认端口 51919）。
2. 打开要分析的页面（登录状态无所谓，扩展用的是你当前会话）。
3. 点扩展图标：
   - 顶部状态应为「已连接」；
   - 点「授权当前标签页」；
   - 标签页顶部出现「DSH 正在调试此浏览器」提示条即生效。
4. 回到 DSH 对话，让模型用 `page_*` 工具分析；弹窗里能看到每个已授权标签页的请求/日志条数。

点「取消授权」或关闭标签页会立即断开该页的调试会话。

## 新功能

- **iframe**：同源 iframe 用 `Runtime.executionContextCreated` 的 contextId；跨进程 iframe（OOPIF）用
  `Target.setAutoAttach` + `Target.sendMessageToTarget` 子会话。`Page.frameDetached(reason=swap)`
  是进程交换，不能当成删除。iframe 内点击会把元素坐标加上逐层 iframe 偏移后再发 CDP 鼠标事件。
- **WebSocket**：记录 `webSocketCreated / HandshakeResponse / FrameSent / FrameReceived / Closed`，
  每个 socket 保留最近 200 帧；二进制帧只保留大小。
- **录制**：`Runtime.addBinding` 注入 `__dshRecordEvent`，页面里捕获 click/input/change/Enter，
  选择器优先 `data-csi-automation` / `data-testid` / 真实 id / name / aria-label，密码值打码；
  Host 侧把动作与请求按时间关联，生成 Node / 浏览器脚本。

详细用法见仓库根目录的 README。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `debugger` | 通过 CDP 在已授权标签页执行 JS、抓网络、读控制台、发鼠标/键盘事件 |
| `tabs` | 列出标签页、切换、导航/刷新、读取标题与 URL |
| `storage` | 记住端口/令牌/客户端 ID（`storage.session` 存临时授权） |
| `alarms` | Service Worker 被回收后兜底重连 |
| `<all_urls>` | `chrome.debugger` 需要目标标签页的 host 权限；只对已授权标签页实际附加 |

扩展不会读取浏览历史、书签、文件或密码；只有被显式授权的标签页会被操作。

## 高级设置

- **宿主端口**：默认 `51919`，需与 Host 插件 `config.port` 一致。
- **配对令牌**：可选。Host 插件配置了 `token` 时这里必须填同一个值。
- 修改后点「保存并重连」。

## 排错

- **未连接**：确认 DSH 进程在跑、Host 插件已启用、端口一致；点「保存并重连」。
- **无法附加调试器**：目标标签页打开了 DevTools，先关掉再授权。
- **调试会话已断开**：DevTools 被打开、页面崩溃或扩展被重载；重新授权。
- **页面没反应**：确认是 http/https 页面（`chrome-extension://`、`edge://` 等不支持）。

## 开发

- `sw.js` 是唯一的后台逻辑：WebSocket 客户端、`chrome.debugger` RPC 分发、网络/控制台缓冲。
- `popup.js` 只做状态展示与授权操作，通过 `chrome.runtime.sendMessage` 调 SW。
- 调试：`edge://extensions` → 该扩展「Service Worker」链接打开控制台；
  在 SW 控制台可查看 `__dshBridge.state`（连接状态、端口、重试计数）。
