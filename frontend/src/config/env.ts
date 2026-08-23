/**
 * 前端运行时环境配置（来自 Vite 环境变量）。
 *
 * - 开发：`.env.development`（可被 `.env.development.local` 覆盖）
 * - 生产：`.env.production`
 * - 仅 `VITE_*` 会打进客户端包
 */

import { currentHostUrl, normalizeHostUrl } from '@/utils/hostStorage'

/**
 * 后端 HTTP 基础 URL；空表示同源（相对路径 `/api/...`）。
 * 多主机场景下仅用于生成内置「本地主机」的地址（见 utils/hostStorage），
 * 实际请求地址一律取自「当前主机」。
 */
export const apiBaseUrl = normalizeHostUrl(import.meta.env.VITE_API_BASE_URL ?? '')

/**
 * 拼接 API 路径：请求「当前主机」的地址（运行时可变）。
 * @param path 以 `/` 开头的路径，如 `/api/v1/agents`
 * @param base 可选：覆盖当前主机（添加主机校验 / 切换前认证等场景按目标主机请求）
 */
export function apiUrl(path: string, base?: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const origin = base ?? currentHostUrl()
  return `${origin}${p}`
}

/**
 * WebSocket 基础 URL：与「当前主机」HTTP 地址同源（http→ws / https→wss）。
 */
export function wsBaseUrl(base?: string): string {
  const host = base ?? currentHostUrl()
  return host.replace(/^http/i, 'ws')
}

/**
 * 拼接 WebSocket 路径，如 `/api/v1/ws`
 * @param base 可选：覆盖当前主机（与 apiUrl 的 base 语义一致）
 */
export function wsUrl(path: string, base?: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${wsBaseUrl(base)}${p}`
}