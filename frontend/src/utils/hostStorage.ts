/**
 * 多主机本地存储（数据层，无框架依赖）。
 *
 * 与 authStorage 同模式：独立纯模块，供请求层（api/http.ts、useAcpSocket）、
 * stores/hosts、stores/auth 共享，避免 pinia store ↔ api 的静态循环依赖。
 *
 * 存储设计（全部仅存浏览器，后端无感知）：
 * - 主机列表：localStorage `zacp.hosts.list`（JSON 数组）；
 * - 当前主机：localStorage `zacp.hosts.current`（主机地址字符串）；
 * - 每台主机的 token / 用户名 / 过期时间都挂在对应主机记录上，
 *   与「添加主机后不再需要后端参与」的约束一致。
 *
 * 内置「本地主机」：地址 = VITE_API_BASE_URL（未配置时 = 当前页面 origin），
 * 不可删除（保证始终有一台兜底主机），初始化时自动补入列表。
 */

/** 单个主机配置（localStorage 持久化结构） */
export interface HostConfig {
  /** 唯一 id（仅本地使用，添加时生成） */
  id: string
  /** 显示名称（用户输入；内置本地主机为固定名称） */
  name: string
  /** 规范化后的地址：http(s)://host[:port]，无尾部斜杠 */
  url: string
  /** 内置本地主机标记（不可删除） */
  builtin?: boolean
  /** 缓存的后端认证启用状态（/auth/status 结果；unknown 时未探测） */
  authEnabled?: boolean
  /** 该主机最近一次登录成功时的用户名（重认证时预填输入框用） */
  username?: string
  /** 该主机的登录 token（仅启用认证的主机有） */
  token?: string
  /** 本地记录的 token 过期时间戳（ms；登录/刷新接口的 expiresIn 换算） */
  tokenExpiresAt?: number
}

const HOSTS_KEY = 'zacp.hosts.list'
const CURRENT_HOST_KEY = 'zacp.hosts.current'

/** 配置的部署后端地址（VITE_API_BASE_URL，可能为空 = 同源部署） */
const CONFIGURED_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? ''

/**
 * 规范化主机地址（添加/编辑主机时校验）：
 * - 去掉首尾空白；
 * - 必须 http:// 或 https:// 开头（不做自动补协议，防手误）；
 * - 只保留 origin（协议 + host[:port]），自动去掉末尾 `/` 与路径/查询/哈希；
 * - 非法（空、无协议、URL 解析失败）返回空串，由调用方提示。
 */
export function normalizeHostUrl(raw: string): string {
  const url = raw.trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return ''
  }
  try {
    // URL.origin 只含协议+host+port，天然满足「去掉路径」；默认端口（80/443）会自动省略
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * 内置「本地主机」的地址：配置的 VITE_API_BASE_URL 优先（开发直连后端），
 * 否则为当前页面 origin（生产同域部署）。
 */
export function localHostUrl(): string {
  return normalizeHostUrl(CONFIGURED_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : ''))
}

function readRawHosts(): HostConfig[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(HOSTS_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as HostConfig[]) : []
  } catch {
    // 数据损坏时视为空列表，由初始化重建（旧数据不阻塞使用）
    return []
  }
}

function writeRawHosts(list: HostConfig[]): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(HOSTS_KEY, JSON.stringify(list))
}

/**
 * 读取主机列表。内置本地主机不存在时自动补入（幂等，
 * 首次初始化 / 用户清 localStorage 后恢复兜底）。
 */
export function readHosts(): HostConfig[] {
  const list = readRawHosts()
  const local = localHostUrl()
  if (local && !list.some((h) => h.url === local)) {
    // 本地主机永远排在最前（默认当前主机）
    list.unshift({
      id: 'local',
      name: '本地主机',
      url: local,
      builtin: true,
    })
    writeRawHosts(list)
  }
  return list
}

/** 持久化主机列表（调用方负责保证内置本地主机不被移除） */
export function writeHosts(list: HostConfig[]): void {
  writeRawHosts(list)
}

/** 当前主机地址（默认本地主机；无有效值时回退本地主机并写回） */
export function currentHostUrl(): string {
  const local = localHostUrl()
  if (typeof localStorage === 'undefined') {
    return local
  }
  const stored = localStorage.getItem(CURRENT_HOST_KEY)
  if (stored && readHosts().some((h) => h.url === stored)) {
    return stored
  }
  if (stored) {
    // 当前主机记录已不在列表（理论上只会发生在 local 兜底被删，这里一并清理）
    localStorage.removeItem(CURRENT_HOST_KEY)
  }
  writeCurrentHostUrl(local)
  return local
}

/** 设置当前主机地址（切换主机成功后调用；随后配合整页刷新重建应用状态） */
export function writeCurrentHostUrl(url: string): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(CURRENT_HOST_KEY, url)
}

/** 按地址查找主机；不存在返回 undefined */
export function findHost(url: string): HostConfig | undefined {
  return readHosts().find((h) => h.url === url)
}

/** 按 id 查找主机（编辑/删除等以 id 为稳定标识的操作）；不存在返回 undefined */
export function findHostById(id: string): HostConfig | undefined {
  return readHosts().find((h) => h.id === id)
}

/** 更新某台主机的部分字段并持久化；主机不存在时静默忽略 */
export function updateHost(url: string, patch: Partial<HostConfig>): void {
  const list = readHosts()
  const idx = list.findIndex((h) => h.url === url)
  if (idx < 0) {
    return
  }
  list[idx] = { ...list[idx], ...patch }
  // 兼容：patch 显式置 undefined 的字段也应移除（如 token 清除）
  for (const key of Object.keys(patch) as (keyof HostConfig)[]) {
    if (list[idx][key] === undefined) {
      delete list[idx][key]
    }
  }
  writeHosts(list)
}

/** 读取某主机的登录 token；不存在返回空串 */
export function readHostToken(url: string): string {
  return findHost(url)?.token ?? ''
}

/**
 * 按 id 更新主机字段（编辑主机信息 / 清除凭证等）。
 *
 * - patch.url 变更时：与其它主机（含本地主机）去重，冲突抛 `hosts.duplicate`；
 *   若该主机正是当前主机，同步 localStorage 的 current 键（调用方随后整页刷新）；
 * - token/authEnabled 等字段显式传 undefined 会从记录中移除（与 updateHost 同语义）。
 * 主机不存在时静默忽略。
 */
export function updateHostById(id: string, patch: Partial<HostConfig>): void {
  const list = readHosts()
  const idx = list.findIndex((h) => h.id === id)
  if (idx < 0) {
    return
  }
  const next = { ...list[idx], ...patch }
  if (patch.url && patch.url !== list[idx].url) {
    // 地址是主机唯一标识：新地址被其它记录占用（含本地主机）则拒绝保存
    if (list.some((h) => h.id !== id && h.url === patch.url)) {
      throw new Error('hosts.duplicate')
    }
    // 当前主机改地址：current 键一并迁移，否则刷新后回退错误
    if (typeof localStorage !== 'undefined' && localStorage.getItem(CURRENT_HOST_KEY) === list[idx].url) {
      localStorage.setItem(CURRENT_HOST_KEY, patch.url)
    }
  }
  // 兼容：patch 显式置 undefined 的字段也应移除（如 token 清除）
  for (const key of Object.keys(patch) as (keyof HostConfig)[]) {
    if (next[key] === undefined) {
      delete next[key]
    }
  }
  list[idx] = next
  writeHosts(list)
}

/**
 * 按 id 删除主机（纯本地操作，凭证随记录一并清除）。
 * 返回被删除的主机；不存在返回 undefined。
 * 注意：调用方需处理「删除的是当前主机」——current 键指向的记录已消失，
 * 读取时会自动回退本地主机（见 currentHostUrl），但显式切回并刷新更明确。
 */
export function removeHostById(id: string): HostConfig | undefined {
  const list = readHosts()
  const idx = list.findIndex((h) => h.id === id)
  if (idx < 0) {
    return undefined
  }
  const [removed] = list.splice(idx, 1)
  writeHosts(list)
  return removed
}

/** 写入某主机的登录 token 与过期时间（登录/刷新成功时调用） */
export function writeHostToken(url: string, token: string, expiresAt?: number): void {
  updateHost(url, { token, tokenExpiresAt: expiresAt ?? Date.now() + 7 * 24 * 3600 * 1000 })
}

/** 清除某主机的登录 token（401 / 登出时调用） */
export function clearHostToken(url: string): void {
  updateHost(url, { token: undefined, tokenExpiresAt: undefined })
}