/**
 * host store 业务错误的识别工具。
 *
 * 约定：stores/hosts 抛出的 Error.message 一律为 i18n key（以 `hosts.` 前缀），
 * UI 层据此用 t() 翻译；网络/解析层错误透传原始 message（或统一回退提示）。
 */

/** 是否为主机 store 抛出的业务错误（message 为 i18n key） */
export function isHostStoreError(e: unknown): e is Error {
  return e instanceof Error && /^hosts\./.test(e.message)
}