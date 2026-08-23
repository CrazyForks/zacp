<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { fetchCaptcha, login } from '@/api'
import { ApiError } from '@/api/types'
import { useHostsStore } from '@/stores/hosts'
import { isHostStoreError } from '@/utils/hostError'
import { normalizeHostUrl } from '@/utils/hostStorage'

/**
 * 添加主机弹窗（需求 3）。两阶段：
 * 1. 表单：显示名称（必填）+ 主机地址（必填，自动补 http://）；
 *    提交时校验目标后端可达（GET /auth/status 200 + 合法 JSON = 通过）；
 * 2. 后端启用密码认证 → 二次认证：用户名/密码/图形验证码（登录成功才添加，
 *    用户名与 token 存入该主机记录，下次重认证自动填充用户名）。
 * 添加成功后不切换当前主机。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const hostsStore = useHostsStore()

// —— 阶段 1：基本信息 ——
const name = ref('')
const url = ref('')
const probing = ref(false)
const formError = ref('')
/** 当前表单地址的规范化结果（探测与添加共用，避免重复解析） */
let normalizedUrl = ''

// —— 阶段 2：二次认证（仅目标主机启用认证时进入） ——
const phase = ref<'form' | 'auth'>('form')
const username = ref('')
const password = ref('')
const captchaId = ref('')
const captchaImage = ref('')
const captchaCode = ref('')
const captchaLoading = ref(false)
const submitting = ref(false)
const authError = ref('')

/** 弹窗打开时重置全部状态（上次添加的残留不带到下次） */
watch(
  () => props.show,
  (open) => {
    if (!open) {
      return
    }
    name.value = ''
    url.value = ''
    normalizedUrl = ''
    formError.value = ''
    phase.value = 'form'
    username.value = ''
    password.value = ''
    captchaCode.value = ''
    authError.value = ''
  },
)

async function refreshCaptcha() {
  if (!normalizedUrl) {
    return
  }
  captchaLoading.value = true
  try {
    const res = await fetchCaptcha({ baseUrl: normalizedUrl })
    captchaId.value = res.id
    captchaImage.value = res.image
  } catch {
    // 静默：验证码加载失败不阻断，提交时会提示刷新
  } finally {
    captchaLoading.value = false
  }
}

/** 阶段 1 提交：校验后端可达性；启用认证则进入二次认证，否则直接添加 */
async function handleProbe() {
  if (probing.value) {
    return
  }
  if (!name.value.trim()) {
    formError.value = t('hosts.nameRequired')
    return
  }
  const raw = url.value.trim()
  if (!raw) {
    formError.value = t('hosts.urlRequired')
    return
  }
  const normalized = normalizeHostUrl(raw)
  if (!normalized) {
    formError.value = t('hosts.urlInvalid')
    return
  }
  normalizedUrl = normalized
  probing.value = true
  formError.value = ''
  try {
    const status = await hostsStore.probeHostUrl(normalized)
    if (status.enabled) {
      // 后端启用密码认证：二次认证（验证码仅认证启用时强制）
      phase.value = 'auth'
      username.value = ''
      void refreshCaptcha()
    } else {
      hostsStore.addHostRecord(name.value, normalized)
      message.success(t('hosts.addSuccess'))
      emit('update:show', false)
    }
  } catch (e) {
    // store 业务错误（地址重复等）按其 i18n key 显示；网络/解析失败统一提示
    formError.value = isHostStoreError(e)
      ? t(e.message)
      : t('hosts.addCheckFailed')
  } finally {
    probing.value = false
  }
}

/** 阶段 2 提交：登录目标主机，成功后把凭证存入主机记录并添加 */
async function handleAuthSubmit() {
  if (submitting.value) {
    return
  }
  const uname = username.value.trim()
  if (!uname) {
    authError.value = t('login.usernameRequired')
    return
  }
  if (!password.value) {
    authError.value = t('login.passwordRequired')
    return
  }
  const c = captchaCode.value.trim()
  if (!c) {
    authError.value = t('login.captchaRequired')
    return
  }
  // 前端优先校验格式：4位字母数字，减轻无效后端请求（与登录页一致）
  if (c.length !== 4 || !/^[A-Za-z0-9]{4}$/.test(c)) {
    authError.value = t('login.captchaInvalid')
    return
  }
  submitting.value = true
  authError.value = ''
  try {
    const res = await login(
      uname,
      password.value,
      captchaId.value || undefined,
      c || undefined,
      { baseUrl: normalizedUrl },
    )
    // 认证通过：凭证随主机记录一起持久化（需求：用户名保存供下次自动填充）
    hostsStore.addHostRecord(name.value, normalizedUrl, res)
    message.success(t('hosts.addSuccess'))
    emit('update:show', false)
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 'captcha_required') {
        authError.value = t('login.captchaRequired')
      } else if (e.code === 'captcha_invalid') {
        authError.value = t('login.captchaInvalid')
      } else if (e.code === 'ip_blocked') {
        authError.value = t('login.ipBlocked')
      } else {
        authError.value = t('login.failed')
      }
    } else if (isHostStoreError(e)) {
      // addHostRecord 的重复地址等业务错误
      authError.value = t(e.message)
    } else {
      authError.value = t('login.failed')
    }
    // 验证码单次有效，失败后刷新并清空输入
    captchaCode.value = ''
    void refreshCaptcha()
  } finally {
    submitting.value = false
  }
}

/** 认证失败后允许回退修改地址/名称（左上角返回按钮） */
function backToForm() {
  phase.value = 'form'
  authError.value = ''
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('hosts.addTitle')"
    :mask-closable="true"
    style="width: 420px"
    @update:show="emit('update:show', $event)"
  >
    <!-- 阶段 1：名称 + 地址 -->
    <form v-if="phase === 'form'" class="flex flex-col gap-4" @submit.prevent="handleProbe">
      <n-input
        v-model:value="name"
        :placeholder="t('hosts.namePlaceholder')"
        size="large"
      />
      <n-input
        v-model:value="url"
        :placeholder="t('hosts.urlPlaceholder')"
        size="large"
        @keydown.enter.prevent="handleProbe"
      />
      <p v-if="formError" class="text-sm text-red-500">{{ formError }}</p>
      <n-button
        type="primary"
        size="large"
        block
        attr-type="submit"
        :loading="probing"
      >
        {{ t('common.next') }}
      </n-button>
    </form>

    <!-- 阶段 2：二次认证（目标主机启用密码认证） -->
    <form v-else class="flex flex-col gap-4" @submit.prevent="handleAuthSubmit">
      <div class="flex items-center gap-1 text-xs text-ink-muted">
        <button
          type="button"
          class="cursor-pointer text-ink-secondary underline-offset-2 hover:underline"
          @click="backToForm"
        >
          ← {{ t('hosts.backToForm') }}
        </button>
        <span class="truncate">{{ t('hosts.authNeededHint') }}</span>
      </div>
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
      <p v-if="authError" class="text-sm text-red-500">{{ authError }}</p>
      <n-button
        type="primary"
        size="large"
        block
        attr-type="submit"
        :loading="submitting"
      >
        {{ t('hosts.authSubmit') }}
      </n-button>
    </form>
  </n-modal>
</template>