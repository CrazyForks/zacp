import { apiUrl } from '@/config/env'
import { clearAuthToken, readAuthToken } from '@/utils/authStorage'
import { readHostToken } from '@/utils/hostStorage'
import { ApiError, type HttpMethod, type RequestOptions } from './types'

/**
 * 将 query 对象编码为 `?a=1&b=2`；无有效参数时返回空串。
 */
function buildQuery(query?: RequestOptions['query']): string {
  if (!query) {
    return ''
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue
    }
    params.set(key, String(value))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

/**
 * 解析后端错误 JSON；非约定格式时回退到通用 code。
 */
async function parseError(res: Response): Promise<ApiError> {
  let body: unknown
  let code = `http_${res.status}`
  let message = res.statusText || `HTTP ${res.status}`

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      body = await res.json()
      const err = (body as { error?: { code?: string; message?: string } })?.error
      if (err?.code) {
        code = err.code
      }
      if (err?.message) {
        message = err.message
      }
    } catch {
      // 保持默认 message
    }
  } else {
    try {
      const text = await res.text()
      if (text) {
        message = text.slice(0, 500)
        body = text
      }
    } catch {
      // ignore
    }
  }

  return new ApiError({ status: res.status, code, message, body })
}

/**
 * 认证免跳转路径：这些端点的 401 属于正常业务返回（登录失败 / 状态查询），
 * 不应触发「清 token + 打开重认证弹窗」的全局拦截。
 * 注意：/auth/refresh 的 401 表示旧 token 已失效，由「切换主机」流程自身
 * catch 并引导重新认证，这里同样不参与全局拦截（避免弹窗双重触发）。
 */
const AUTH_FREE_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/status',
  '/api/v1/auth/captcha',
  '/api/v1/auth/refresh',
]

/** 401 全局拦截回调（由入口注入，见 main.ts）：业务层打开当前主机的重认证弹窗 */
type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null

/**
 * 注册/清除 401 全局拦截回调。
 * 请求层不 import 任何 store（避免 api → store 的依赖倒置与模块循环），
 * 由应用入口（main.ts）注入真实实现——那里 import store 无循环、解析直接。
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

/**
 * 401 全局拦截：清除「当前主机」的登录 token，并触发重认证回调。
 *
 * 多主机改造前是「清 token + 整页跳 /login」；改造后登录态按主机隔离，
 * 一台主机的 token 失效不应把整个应用踢去登录页——清除当前主机 token 后
 * 由注入的处理器弹窗让用户重新认证（对当前主机），其余主机不受影响。
 *
 * 结构性约束：带 baseUrl 覆盖的请求（目标主机探测/登录/刷新）都在
 * AUTH_FREE_PATHS 内，401 不会走到这里（由 hosts store 的切换流程自行处理）；
 * 若将来新增带 baseUrl 的业务请求，其 401 语义需在此一并设计（清谁、弹谁）。
 */
function handleUnauthorized(): void {
  clearAuthToken()
  unauthorizedHandler?.()
}

/**
 * 底层请求：自动拼接「当前主机」地址 + 路径。
 *
 * @param path 仅写后端路径即可，例如 `/api/v1/agents`（可省略前导 `/`）
 *
 * @example
 * ```ts
 * const data = await request<{ agents: Agent[] }>('GET', '/api/v1/agents')
 * await request('POST', '/api/v1/sessions', { body: { agentId: 'reasonix' } })
 * // 按目标主机请求（不改变当前主机）：
 * await request('GET', '/api/v1/auth/status', { baseUrl: 'http://other:8680' })
 * ```
 */
export async function request<T = unknown>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { query, body, headers = {}, signal, json = true, baseUrl } = options

  const url = apiUrl(path, baseUrl) + buildQuery(query)

  const init: RequestInit = {
    method,
    signal,
    headers: { ...headers },
  }

  // 登录 token：存在则统一带 Authorization Bearer（认证未启用时后端直接忽略）。
  // baseUrl 覆盖时用目标主机的 token（如切换前对目标主机刷新/登录），否则用当前主机。
  const token = baseUrl ? readHostToken(baseUrl) : readAuthToken()
  if (token) {
    ;(init.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
  }

  if (body !== undefined && body !== null && method !== 'GET') {
    if (body instanceof FormData) {
      // 让浏览器自动带 multipart boundary，不要设 Content-Type
      init.body = body
    } else {
      ;(init.headers as Record<string, string>)['Content-Type'] =
        'application/json'
      init.body = JSON.stringify(body)
    }
  }

  // 期望 JSON 时显式 Accept，便于后端与中间层识别
  if (json && !(init.headers as Record<string, string>)['Accept']) {
    ;(init.headers as Record<string, string>)['Accept'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    // 网络错误 / 被 abort
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: err instanceof Error ? err.message : 'Network request failed',
      body: err,
    })
  }

  if (!res.ok) {
    // 认证失败：清当前主机 token 并打开重认证弹窗（登录/状态/刷新等接口除外）
    if (res.status === 401 && !AUTH_FREE_PATHS.some((p) => path.startsWith(p))) {
      handleUnauthorized()
    }
    throw await parseError(res)
  }

  // 204 / 空体
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }

  if (!json) {
    return res as unknown as T
  }

  // 部分 DELETE 成功无 body
  const text = await res.text()
  if (!text) {
    return undefined as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError({
      status: res.status,
      code: 'invalid_json',
      message: 'Response is not valid JSON',
      body: text,
    })
  }
}

/** 面向业务的快捷方法：路径只写 `/api/v1/...` */
export const http = {
  get<T = unknown>(path: string, options?: Omit<RequestOptions, 'body'>) {
    return request<T>('GET', path, options)
  },

  post<T = unknown>(path: string, options?: RequestOptions) {
    return request<T>('POST', path, options)
  },

  put<T = unknown>(path: string, options?: RequestOptions) {
    return request<T>('PUT', path, options)
  },

  patch<T = unknown>(path: string, options?: RequestOptions) {
    return request<T>('PATCH', path, options)
  },

  delete<T = unknown>(path: string, options?: RequestOptions) {
    return request<T>('DELETE', path, options)
  },
}

export default http