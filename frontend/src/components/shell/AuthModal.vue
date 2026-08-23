<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { fetchCaptcha, login } from '@/api'
import { ApiError } from '@/api/types'
import { connect as acpConnect } from '@/composables/useAcpSocket'
import { useHostsStore } from '@/stores/hosts'

/**
 * 全局重认证弹窗：对「当前主机」/切换目标主机重新登录（用户名/密码/图形验证码）。
 *
 * 触发源（全部幂等，同一时刻只服务一台主机）：
 * - HTTP 业务请求 401（http.ts 全局拦截）；
 * - WS 连续握手失败兜底（useAcpSocket，服务重启后内存 token 全失场景）；
 * - 路由守卫发现当前主机启用认证但本地无 token；
 * - 切换主机时目标主机 token 失效/过期/从未登录。
 *
 * 成功后 hostsStore.authSuccessFor 按发起登录快照的主机写回 token/用户名/过期时间，
 * 并关闭弹窗（请求仍匹配时）；取消 / 关闭 = hostsStore.authCancel（切换流程据此中止）。
 */
const { t } = useI18n()
const message = useMessage()
const hostsStore = useHostsStore()

const host = computed(() => hostsStore.authModalHost)

const username = ref('')
const password = ref('')
const captchaId = ref('')
const captchaImage = ref('')
const captchaCode = ref('')
const captchaLoading = ref(false)
const submitting = ref(false)
const errorMsg = ref('')

/** 弹窗标题：登录目标主机（内置本地主机按当前语言显示，区分切换场景） */
const title = computed(() => {
  const h = host.value
  if (!h) {
    return t('hosts.authTitle')
  }
  const name = h.builtin ? t('hosts.localName') : h.name
  return `${t('hosts.authTitle')} · ${name}`
})

async function refreshCaptcha() {
  const h = host.value
  if (!h) return
  captchaLoading.value = true
  try {
    const res = await fetchCaptcha({ baseUrl: h.url })
    captchaId.value = res.id
    captchaImage.value = res.image
  } catch {
    // 静默：验证码加载失败不阻断登录，下次提交会提示刷新
  } finally {
    captchaLoading.value = false
  }
}

/**
 * 弹窗重置：监听「打开状态 + 目标主机 URL」两个维度。
 * 换主机路径（401 拦截/守卫/二次切换）会在同一同步栈内 open=false→true，
 * watch 只看最终值可能不触发；监听 URL 变化确保换弹窗主机时同样重置表单
 * （否则旧主机的用户名/验证码残留，新主机首次提交必失败且凭证串台）。
 */
watch(
  () => [hostsStore.authModalOpen, hostsStore.authModalHost?.url] as const,
  ([open]) => {
    if (!open) {
      return
    }
    username.value = hostsStore.authModalHost?.username ?? ''
    password.value = ''
    captchaCode.value = ''
    errorMsg.value = ''
    submitting.value = false
    void refreshCaptcha()
  },
)

async function handleSubmit() {
  const h = host.value
  if (!h || submitting.value) {
    return
  }
  // 发起前快照目标主机与请求代际：登录在途时弹窗可能被换主机/取消/同主机重开，
  // 凭证必须写回发起登录的主机，且只有最新代际的响应才做页面级收尾，
  // 见 hostsStore.authSuccessFor
  const targetUrl = h.url
  const authSeq = hostsStore.currentAuthSeq()
  const uname = username.value.trim()
  if (!uname) {
    errorMsg.value = t('login.usernameRequired')
    return
  }
  if (!password.value) {
    errorMsg.value = t('login.passwordRequired')
    return
  }
  const c = captchaCode.value.trim()
  if (!c) {
    errorMsg.value = t('login.captchaRequired')
    return
  }
  // 前端优先校验格式：4位字母数字，减轻无效后端请求（与登录页一致）
  if (c.length !== 4 || !/^[A-Za-z0-9]{4}$/.test(c)) {
    errorMsg.value = t('login.captchaInvalid')
    return
  }
  submitting.value = true
  errorMsg.value = ''
  try {
    const res = await login(
      uname,
      password.value,
      captchaId.value || undefined,
      c || undefined,
      { baseUrl: targetUrl },
    )
    // 写回发起主机的记录（token/用户名/过期时间）；若请求仍匹配当前弹窗（URL+代际）则关闭并 resolve
    hostsStore.authSuccessFor(targetUrl, res, authSeq)
    message.success(t('login.success'))
    // 仅当认证目标就是当前主机时才恢复主通道（切换场景下当前主机连接原样保留）
    if (targetUrl === hostsStore.currentUrl) {
      acpConnect()
    }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'captcha_required') {
        errorMsg.value = t('login.captchaRequired')
      } else if (e.code === 'captcha_invalid') {
        errorMsg.value = t('login.captchaInvalid')
      } else if (e.code === 'ip_blocked') {
        errorMsg.value = t('login.ipBlocked')
      } else {
        errorMsg.value = t('login.failed')
      }
    } else {
      errorMsg.value = t('login.failed')
    }
    // 验证码单次有效，失败后刷新并清空输入（与登录页一致）
    captchaCode.value = ''
    void refreshCaptcha()
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <n-modal
    :show="hostsStore.authModalOpen"
    preset="card"
    :title="title"
    :mask-closable="true"
    style="width: 400px"
    @close="hostsStore.authCancel()"
  >
    <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
      <n-input
        v-model:value="username"
        :placeholder="t('login.username')"
        size="large"
        autocomplete="username"
      />
      <n-input
        v-model:value="password"
        type="password"
        show-password-on="click"
        :placeholder="t('login.password')"
        size="large"
        autocomplete="current-password"
      />

      <!-- 图形验证码（该主机启用认证，必填） -->
      <div class="flex gap-2">
        <n-input
          v-model:value="captchaCode"
          :placeholder="t('login.captchaPlaceholder')"
          size="large"
          autocomplete="off"
          class="flex-1"
        />
        <img
          v-if="captchaImage"
          :src="captchaImage"
          :alt="t('login.captcha')"
          :title="t('login.captchaRefresh')"
          class="h-[40px] w-[120px] cursor-pointer rounded border border-gray-200 object-cover dark:border-gray-700"
          @click="refreshCaptcha"
        />
        <div
          v-else
          class="flex h-[40px] w-[120px] cursor-pointer items-center justify-center rounded border border-gray-200 text-xs text-gray-400 dark:border-gray-700"
          @click="refreshCaptcha"
        >
          {{ captchaLoading ? '...' : t('login.captchaRefresh') }}
        </div>
      </div>

      <!-- 错误提示 -->
      <p v-if="errorMsg" class="text-sm text-red-500">{{ errorMsg }}</p>

      <n-button
        type="primary"
        size="large"
        block
        attr-type="submit"
        :loading="submitting"
      >
        {{ t('login.submit') }}
      </n-button>
    </form>
  </n-modal>
</template>