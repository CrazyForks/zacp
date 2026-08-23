import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fetchAuthStatus,
  refreshToken,
  type AuthStatus,
  type LoginResult,
} from '@/api'
import { ApiError } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import {
  type HostConfig,
  HOST_NAME_MAX,
  currentHostUrl,
  findHost,
  findHostById,
  localHostUrl,
  normalizeHostUrl,
  readHosts,
  readHostToken,
  removeHostById,
  updateHost,
  updateHostById,
  writeCurrentHostUrl,
  writeHosts,
} from '@/utils/hostStorage'

/** 生成本地唯一 id（浏览器不支持 crypto.randomUUID 时回退时间戳+随机数） */
function newHostId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 多主机 store：主机列表（localStorage 持久化，仅浏览器）+ 全局重认证弹窗 + 切换/添加流程。
 *
 * 关键设计：
 * - 列表与当前主机地址存 localStorage（utils/hostStorage），请求层直接读它，
 *   本 store 只负责响应式状态与业务流程，不承担请求层的 URL 拼接；
 * - 「切换主机」= 认证探测/续期/重认证全部走 `baseUrl` 覆盖（目标主机）
 *   完成之后，再写当前主机地址并**整页刷新**：所有 store（session/agent/auth）
 *   与 WS 连接自然重建，首页守卫按「第一个项目 + 最近活跃 session」跳转
 *   （需求 6），无需逐 store 重置；
 * - 全局重认证弹窗同一时刻只服务一台主机（authModalHost），401 拦截与
 *   切换流程共用，幂等（已打开时复用进行中的 promise）。
 */
export const useHostsStore = defineStore('hosts', () => {
  /** 主机列表（读时自动补内置本地主机，永远排第一） */
  const hosts = ref<HostConfig[]>(readHosts())
  /** 当前主机地址（默认本地主机） */
  const currentUrl = ref(currentHostUrl())

  /** 当前主机配置（列表被清空等极端情况回退到本地主机兜底） */
  const current = computed<HostConfig>(
    () => hosts.value.find((h) => h.url === currentUrl.value) ?? hosts.value[0],
  )

  // —— 全局重认证弹窗状态（AuthModal 组件渲染，认证对 authRequest.host 这台主机） ——
  const authModalOpen = ref(false)
  /** 弹窗当前展示的目标主机（仅 UI 渲染用；业务归属以 authRequest.host 为准） */
  const authModalHost = ref<HostConfig | null>(null)
  /** 认证请求代际：每次 requestAuth 递增，AuthModal 提交时快照，响应到达时校验「仍是最新弹窗」 */
  let authSeq = 0
  let authRequest: {
    /** 发起认证请求时快照的目标主机：弹窗可能被后续请求换主机，成功回调必须写回发起时的主机 */
    host: HostConfig
    seq: number
    promise: Promise<LoginResult | null>
    resolve: (r: LoginResult | null) => void
  } | null = null

  /** 当前最新认证请求的代际号（AuthModal 提交时快照；无活动弹窗返回 -1） */
  function currentAuthSeq(): number {
    return authRequest?.seq ?? -1
  }

  /**
   * 打开认证弹窗并等待结果（null = 用户取消）。
   * 幂等：已有进行中弹窗时，仅当目标主机一致才复用其 promise
   * （401 全局弹窗与切换认证可能并发；复用不同主机的 promise 会把
   * 主机 A 的认证结果误当作主机 B 的）；目标不同则先取消旧请求再开新弹窗。
   */
  function requestAuth(host: HostConfig): Promise<LoginResult | null> {
    if (authRequest) {
      if (authRequest.host.url === host.url) {
        return authRequest.promise
      }
      authCancel() // 旧调用方收到 null（其切换/认证流程自然中止）
    }
    authModalHost.value = host
    authModalOpen.value = true
    let resolveFn!: (r: LoginResult | null) => void
    const promise = new Promise<LoginResult | null>((resolve) => {
      resolveFn = resolve
    })
    authRequest = { host, seq: ++authSeq, promise, resolve: resolveFn }
    return promise
  }

  /** 401 全局拦截入口：对当前主机打开重认证弹窗（fire-and-forget） */
  function requestCurrentHostAuth(): void {
    const host = current.value
    if (host) {
      void requestAuth(host)
    }
  }

  /**
   * 认证成功（AuthModal 提交成功后回调）。
   *
   * targetUrl 为发起登录时快照的目标主机（AuthModal 提交瞬间捕获），
   * 凭证一律写回发起登录的主机——弹窗可能在登录请求在途时被换到其它主机
   * （401 拦截 / WS 兜底 / 守卫 / 用户二次点切换都会触发换主机），
   * 不能依赖「当前弹窗主机」判定归属。
   * 仅当当前 in-flight 请求仍匹配该主机时才关闭弹窗并 resolve；
   * 不匹配 = 该请求已被换主机流程取消，此次登录只落库、不打扰新弹窗。
   */
  function authSuccessFor(targetUrl: string, result: LoginResult, seq: number): void {
    updateHost(targetUrl, {
      token: result.token,
      tokenExpiresAt: Date.now() + result.expiresIn * 1000,
      username: result.username,
      authEnabled: true,
    })
    hosts.value = readHosts()
    const req = authRequest
    // 本次提交是否仍是「最新弹窗请求」：弹窗可能在登录在途时被换主机、取消或
    // 同主机重开（URL 相同但代际不同），因此同时校验主机 URL 与代际序号——
    // 仅最新代际的请求才执行页面级收尾；旧代际迟到响应只落库、不打扰当前弹窗。
    const isCurrentRequest = !!req && req.host.url === targetUrl && req.seq === seq
    // 认证目标恰为当前主机时，同步 auth store 的响应式登录态
    if (targetUrl === currentUrl.value) {
      useAuthStore().applyLoggedIn(result.token, result.username)
    }
    if (isCurrentRequest) {
      authRequest = null
      authModalOpen.value = false
      req!.resolve(result)
      // 登录成功 → 用新 token 重载数据（整页重建，首屏请求自动重拉）：
      // - 当前主机重认证（401 触发）：直接 reload——此前 /api/v1/workspaces 等
      //   已因旧 token 401 失败且 loadInitial 把失败结果缓存在内存，不重建页面
      //   就不会重拉，造成「登录成功但项目/会话列表仍为空」；
      // - 切换场景（目标 ≠ 当前主机）：完成切换 + 整页刷新（与 switchHost 的
      //   收尾幂等，双通道最终都落在同一整页重建）。
      if (targetUrl === currentUrl.value) {
        window.location.reload()
      } else {
        commitSwitch(targetUrl)
      }
    }
  }

  /** 认证取消/关闭（AuthModal 取消或直接关闭；换主机复用路径也会先走到这里） */
  function authCancel(): void {
    const req = authRequest
    authRequest = null
    authModalOpen.value = false
    req?.resolve(null)
  }

  /**
   * 校验目标主机可达且为合法 zacp 后端（GET /auth/status）。
   * 网络失败抛错（由 UI 展示）；返回的 enabled 决定后续是否二次认证。
   */
  async function probeHostUrl(rawUrl: string): Promise<AuthStatus> {
    const url = normalizeHostUrl(rawUrl)
    if (!url) {
      throw new Error('hosts.urlInvalid')
    }
    return fetchAuthStatus({ baseUrl: url })
  }

  /**
   * 添加主机记录（需求 3）：不切换当前主机。
   * 校验与二次认证由 HostFormModal 先完成（probeHostUrl + apiLogin），
   * 这里只做去重 + 组装 + 持久化。auth 缺省 = 该主机未启用认证。
   * 返回新主机；地址重复时抛错。
   */
  function addHostRecord(name: string, rawUrl: string, auth?: LoginResult): HostConfig {
    const url = normalizeHostUrl(rawUrl)
    const trimmedName = name.trim()
    if (!url) {
      throw new Error('hosts.urlInvalid')
    }
    if (!trimmedName) {
      throw new Error('hosts.nameRequired')
    }
    if (trimmedName.length > HOST_NAME_MAX) {
      throw new Error('hosts.nameTooLong')
    }
    if (hosts.value.some((h) => h.url === url)) {
      throw new Error('hosts.duplicate')
    }
    const host: HostConfig = {
      id: newHostId(),
      name: trimmedName,
      url,
      authEnabled: auth ? true : undefined,
    }
    if (auth) {
      host.username = auth.username
      host.token = auth.token
      host.tokenExpiresAt = Date.now() + auth.expiresIn * 1000
    }
    hosts.value.push(host)
    writeHosts(hosts.value)
    return host
  }

  /** 同步当前主机的认证启用状态缓存（路由守卫 ensureStatus 后调用，幂等） */
  function cacheAuthEnabled(enabled: boolean): void {
    updateHost(currentUrl.value, { authEnabled: enabled })
    hosts.value = readHosts()
  }

  /**
   * 更新主机信息（编辑弹窗保存；仅改名或改名+改地址）。
   *
   * - 仅名称变更：直接保存，无副作用；
   * - 地址变更：调用方（HostFormModal）已探活新地址，这里清 token/authEnabled
   *   （地址变了 = 可能是另一台后端，旧凭证不可信；username 保留供下次预填），
   *   去重由 hostStorage.updateHostById 兜底（新地址与其它主机冲突抛 hosts.duplicate）；
   * - 返回是否需整页刷新：仅「当前主机改地址」为 true（current 键已同步，刷新后
   *   页面按新地址工作，与切换主机同体验）。
   */
  function updateHostInfo(id: string, next: { name: string; url: string }): boolean {
    const host = findHostById(id)
    if (!host) {
      throw new Error('hosts.notFound')
    }
    // 与 removeHost 对称：内置本地主机不允许编辑（UI 已禁用，store 层防御兜底）
    if (host.builtin) {
      throw new Error('hosts.builtinProtected')
    }
    // 名称校验兜底（UI 已用 maxlength 限制，store 直调不绕过）
    const trimmedName = next.name.trim()
    if (!trimmedName) {
      throw new Error('hosts.nameRequired')
    }
    if (trimmedName.length > HOST_NAME_MAX) {
      throw new Error('hosts.nameTooLong')
    }
    const urlChanged = host.url !== next.url
    if (urlChanged) {
      updateHostById(id, {
        name: trimmedName,
        url: next.url,
        token: undefined,
        tokenExpiresAt: undefined,
        authEnabled: undefined,
      })
      hosts.value = readHosts()
      return host.url === currentUrl.value
    }
    updateHostById(id, { name: trimmedName })
    hosts.value = readHosts()
    return false
  }

  /**
   * 删除主机（纯本地操作，token/用户名随记录清除）。
   * 内置本地主机拒绝删除（hosts.builtinProtected）。
   * 删除的是当前主机时：current 显式回退本地主机并返回 true（调用方整页刷新）。
   */
  function removeHost(id: string): boolean {
    const host = findHostById(id)
    if (!host) {
      throw new Error('hosts.notFound')
    }
    if (host.builtin) {
      throw new Error('hosts.builtinProtected')
    }
    const removed = removeHostById(id)
    if (!removed) {
      throw new Error('hosts.notFound')
    }
    hosts.value = readHosts()
    if (removed.url === currentUrl.value) {
      // 删除的是当前主机：切回内置本地主机兜底（currentHostUrl 读取端也有自动回退）
      writeCurrentHostUrl(localHostUrl())
      return true
    }
    return false
  }

  /** 进行中的切换目标（in-flight 去重：快速重复点击同一主机时忽略，避免并发刷新竞态） */
  let switchingUrl: string | null = null

  /**
   * 切换生效（幂等）：写当前主机地址 + 整页刷新回首页。
   * 整页刷新会重建所有 store/WS/路由，首页守卫自动跳「第一个项目最近 session」，
   * 因此同一次切换中可能被调用两次（switchHost 流程 + authSuccessFor 收尾）：
   * 第二次 assign 会取消并重启同地址导航（或等价 reload），最终仍落在 `/`，
   * current 键同值写入，无状态破坏。
   */
  function commitSwitch(targetUrl: string): void {
    writeCurrentHostUrl(targetUrl)
    window.location.assign('/')
  }

/**
   * 切换主机（需求 4/5/6）。流程：
   * 1. 每次切换都实时探测目标主机（GET /auth/status）确认可达并取认证状态；
   *    网络错误 = 不可达，提示并中止切换；
   * 2. 启用认证的主机：本地 token 未过期 → 调 /auth/refresh 续期 7 天
   *    （顺带探测服务重启/吊销）；返回 401 或本地已过期/无 token →
   *    弹重认证表单（用户名/密码/验证码，用户名预填）；用户取消则中止；
   *    refresh 的其它错误（旧版后端无此接口返回 404、网络抖动、5xx）静默放行；
   * 3. 生效：写当前主机地址 + 整页刷新回首页（守卫自动跳第一个项目最近 session）。
   *
   * 所有针对目标主机的请求都走 baseUrl 覆盖，切换前不动当前主机状态，
   * 失败/取消时当前主机不受任何影响。
   * 抛错由 UI 展示（网络不可达等）；返回 false 表示用户取消或重复点击（静默）。
   */
  async function switchHost(targetUrl: string): Promise<boolean> {
    if (switchingUrl === targetUrl) {
      return false // 同目标切换进行中：忽略重复触发
    }
    const target = hosts.value.find((h) => h.url === targetUrl)
    if (!target) {
      throw new Error('hosts.notFound')
    }
    if (target.url === currentUrl.value) {
      return true
    }
    switchingUrl = targetUrl
    try {
      // 1) 实时探测目标主机（每次切换都请求 /auth/status，不依赖本地缓存）：
      //    一方面确认目标可达——网络错误提示并中止切换，避免切过去后
      //    整页请求全部失败；另一方面拿到认证开关的最新状态（服务端可能
      //    已通过设置页开启/关闭认证）。
      let authEnabled: boolean
      try {
        const status = await fetchAuthStatus({ baseUrl: target.url })
        authEnabled = status.enabled
        updateHost(target.url, { authEnabled })
        hosts.value = readHosts()
      } catch {
        throw new Error('hosts.switchUnreachable')
      }

      // 2) 启用认证的主机：刷新续期或重新认证
      if (authEnabled) {
        const token = readHostToken(target.url)
        // 本地预判未过期（按登录/刷新时记录的过期时间）才走刷新；
        // 已过期直接弹重认证（省一次必 401 的请求）。服务重启导致的实际
        // 失效无法本地预判，由刷新接口的 401 兜底。
        const localFresh = token && (!target.tokenExpiresAt || Date.now() < target.tokenExpiresAt)
        if (localFresh) {
          try {
            const res = await refreshToken({ baseUrl: target.url })
            updateHost(target.url, {
              token: res.token,
              tokenExpiresAt: Date.now() + res.expiresIn * 1000,
              username: res.username,
              authEnabled: true,
            })
            hosts.value = readHosts()
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
              // token 已失效（自然过期 / 服务重启内存清空 / 凭证变更）：重新认证
              const res = await requestAuth(target)
              if (!res) {
                return false // 用户取消切换
              }
            }
            // 其它错误（404 = 目标后端是旧版本没有 refresh 接口、网络抖动、5xx 等）
            // 静默放行，不阻断切换：refresh 只是「续期 + 探测」的优化手段，
            // 切过去后 token 有效则一切正常；无效则由业务请求 401 弹重认证兜底。
          }
        } else {
          const res = await requestAuth(target)
          if (!res) {
            return false
          }
        }
      }
    } finally {
      // 仅清理自己的在途标记：并发切换不同主机时（A 在飞又切 B），
      // A 的 finally 不能把 B 的标记清掉，否则 B 会被重复触发
      if (switchingUrl === targetUrl) {
        switchingUrl = null
      }
    }

    // 3) 生效：持久化 + 整页刷新（重建 store/WS/路由，首页守卫跳转目标会话）。
    //    认证收尾路径（authSuccessFor）可能已先行完成本次切换（见其注释），
    //    此处重复调用幂等无碍。
    commitSwitch(target.url)
    return true
  }

  /** 供 AuthModal 等组件读取（工具方法） */
  function hostByUrl(url: string): HostConfig | undefined {
    return findHost(url)
  }

  return {
    hosts,
    currentUrl,
    current,
    authModalOpen,
    authModalHost,
    requestAuth,
    requestCurrentHostAuth,
    currentAuthSeq,
    authSuccessFor,
    authCancel,
    probeHostUrl,
    addHostRecord,
    updateHostInfo,
    removeHost,
    cacheAuthEnabled,
    switchHost,
    hostByUrl,
  }
})