/**
 * dsh-browser-bridge —— 把「用户真实浏览器」接给 DSH 的 Host 插件。
 *
 * 组成：
 *   本插件（Host）  <— WebSocket(127.0.0.1) —>  浏览器扩展（MV3 + chrome.debugger）
 *
 * 本插件负责：起本地 WS 服务、管理扩展会话、注册 page_* 工具；
 * 扩展负责：在用户显式授权的标签页里执行 CDP 命令、持续捕获网络与控制台。
 */
import { Bridge } from './src/bridge.js';
import { createTools } from './src/tools.js';

/** 插件名（loader 诊断用）。 */
export const name = 'browser-bridge';

/** 需要 tools 注册表。 */
export const inject = ['tools'];

/**
 * @param {import('cordis').Context} ctx
 * @param {{ port?: number, token?: string, extensionIds?: string[] }} config
 */
export function apply(ctx, config = {}) {
  const bridge = new Bridge({
    port: Number(config.port) || 51_919,
    token: config.token ? String(config.token) : '',
    extensionIds: Array.isArray(config.extensionIds) ? config.extensionIds : undefined,
  });

  const ready = bridge.start().catch((error) => {
    bridge.lastError = error instanceof Error ? error.message : String(error);
    console.warn(`[browser-bridge] 启动失败：${bridge.lastError}`);
  });

  for (const tool of createTools(bridge)) {
    ctx.tools.register(tool);
  }

  // 插件卸载（含 HMR 重载）时关闭端口与所有扩展连接。
  ctx.effect(() => () => {
    void ready.then(() => bridge.stop());
  });
}
