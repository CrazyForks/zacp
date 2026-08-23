/**
 * 登录 token 的本地存储工具（无依赖小模块）。
 *
 * 独立成模块是为了让 `api/http.ts`（请求层）与 `stores/auth.ts`（状态层）
 * 共享同一份存取逻辑，避免二者循环依赖（auth store → api → http → auth store）。
 *
 * 多主机改造后：token 按主机维度存储在主机记录中（见 utils/hostStorage），
 * 本模块的 `readAuthToken` 系列语义 = 「当前主机的 token」，签名保持不变，
 * 请求层与各 store 的调用点无需感知主机维度。
 */

import { clearHostToken, currentHostUrl, readHostToken, writeHostToken } from './hostStorage'

/** 读取当前主机的登录 token；无则返回空串（未登录） */
export function readAuthToken(): string {
  if (typeof localStorage === 'undefined') {
    return ''
  }
  return readHostToken(currentHostUrl())
}

/** 写入当前主机的登录 token（登录成功时调用；ttl 按登录接口 expiresIn 换算） */
export function writeAuthToken(token: string, expiresAt?: number): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  writeHostToken(currentHostUrl(), token, expiresAt)
}

/** 清除当前主机的登录 token（登出 / 401 / 凭证变更时调用） */
export function clearAuthToken(): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  clearHostToken(currentHostUrl())
}