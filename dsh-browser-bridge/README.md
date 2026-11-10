# dsh-browser-bridge

DeepSeek Harness Host 插件：起一个本地 WebSocket 桥，把「用户真实浏览器」里的已授权标签页接给模型，
注册 11 个 `page_*` 工具。配套浏览器扩展在 `../extension/`。

## 组成

- `index.js`：插件入口（`apply`），启动 `Bridge` 并注册工具，卸载时关闭端口/连接。
- `src/ws-server.js`：手写 WebSocket 服务端（握手、文本帧、分片、ping/pong、close），零第三方依赖。
- `src/bridge.js`：连接鉴权（扩展 ID + 可选令牌）、会话表、RPC 请求/应答、超时与断开清理。
- `src/tools.js`：工具 schema、参数校验、结果渲染（模型看到的中文文本）。
- `src/script-gen.js`：录制结果 → Node / 浏览器可重放脚本（纯函数，含 multipart 还原、Cookie 剥离）。

## 安装

在 DSH 里：

```text
plugin_manager install_bundle  target = <本目录绝对路径>
```

或手动在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-browser-bridge
      name: dsh-browser-bridge
      config:
        port: 51919
```

安装后 bundle 层会把插件行插进组合，重启/HMR 后 `page_*` 工具出现。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `51919` | 本地 WS 端口，必须与扩展「高级设置」一致 |
| `token` | `''` | 可选配对令牌；非空时扩展必须在 `?token=` 带上同值 |
| `extensionIds` | `['hlfcjpadcahkpbdnhomoagoekopdmnfo']` | 允许连接的扩展 ID 列表 |

## 协议（JSON 文本帧）

```text
扩展 → 宿主   {"type":"hello","protocol":1,"client":{...},"capabilities":[...]}
宿主 → 扩展   {"type":"welcome","protocol":1,"server":"dsh-browser-bridge","version":"0.1.0","sessionId":"..."}
宿主 → 扩展   {"type":"request","id":1,"method":"tab.eval","params":{...}}
扩展 → 宿主   {"type":"reply","id":1,"ok":true,"result":{...}}
              {"type":"reply","id":1,"ok":false,"error":{"message":"..."}}
```

方法：`tabs.list`、`tab.grant`、`tab.activate`、`tab.navigate`、`tab.reload`、`tab.eval`、`tab.query`、
`tab.click`、`tab.type`、`tab.frames`、`tab.network`、`tab.socket`、`tab.console`、`tab.record`、`bridge.status`。

`tab.eval` / `tab.query` / `tab.click` / `tab.type` 支持 `frame` 参数（index / frameId / URL 片段 / name）；
`tab.record` 的 start/stop 结果由 `src/script-gen.js` 生成可重放脚本。

## 测试

```powershell
node --test test/protocol.test.mjs    # 协议 / 鉴权 / 工具渲染
node --test test/script-gen.test.mjs  # 录制脚本生成（过滤、multipart、Cookie 剥离）
```

真实浏览器链路见 `../test/extension.e2e.mjs`（39 项断言：元素、JS、CSP、iframe、WebSocket、录制+重放）。

## 注意

- 桥只绑定 `127.0.0.1`；网页来源（`https://...` Origin）会被拒绝。
- `chrome.debugger` 一次只能有一个调试客户端：扩展授权期间该标签页不能开 DevTools。
- 没有暴露「授权标签页」的工具：授权只能由用户在扩展弹窗里完成（有意的隐私边界）。
