<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { fetchCaptcha, login } from '@/api'
import { ApiError } from '@/api/types'
import { useHostsStore } from '@/stores/hosts'
import { isHostStoreError } from '@/utils/hostError'
import { normalizeHostUrl, HOST_NAME_MAX, type HostConfig } from '@/utils/hostStorage'

/**
 * 主机表单弹窗（添加 / 编辑共用一套表单与校验逻辑）。
 *
 * add 模式（需求 3）：名称+地址 → 校验目标后端可达（GET /auth/status）→
 * 后端启用密码认证则二次认证（用户名/密码/验证码，凭证存入主机记录），
 * 添加成功后不切换当前主机。
 *
 * edit 模式：预填主机当前信息；
 * - 仅改名 → 直接保存，无副作用；
 * - 改地址 → 探活新地址（失败不保存）+ 清除该主机旧凭证（下次切换时重新登录），
 *   若编辑的是当前主机且地址变更 → 保存后整页刷新（current 键已由 store 同步）。
 */
const props = defineProps<{
  show: boolean
  mode: 'add' | 'edit'
  /** edit 模式的目标主机（add 模式忽略） */
  host?: HostConfig | null
}>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const hostsStore = useHostsStore()

// —— 基本信息 ——
const name = ref('')
const url = ref('')
const probing = ref(false)
const formError = ref('')

/** 名称与地址（去空白后）都填写才允许提交（需求：未填完不能点下一步/保存） */
const canSubmit = computed(() => name.value.trim() !== '' && url.value.trim() !== '')
/** 当前表单地址的规范化结果（探测与保存共用，避免重复解析） */
let normalizedUrl = ''

// —— 二次认证（仅 add 模式、目标主机启用认证时进入） ——
const phase = ref<'form' | 'auth'>('form')
const username = ref('')
const password = ref('')
const captchaId = ref('')
const captchaImage = ref('')
const captchaCode = ref('')
const captchaLoading = ref(false)
const submitting = ref(false)
const authError = ref('')

/** 弹窗打开时重置状态：add 清空；edit 预填主机当前信息 */
watch(
  () => props.show,
  (open) => {
    if (!open) {
      return
    }
    if (props.mode === 'edit' && props.host) {
      name.value = props.host.name
      url.value = props.host.url
      normalizedUrl = props.host.url
    } else {
      name.value = ''
      url.value = ''
      normalizedUrl = ''
    }
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

/** 表单提交（add/edit 共用入口）：校验 → 按模式分流 */
async function handleSubmit() {
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
    if (props.mode === 'edit' && props.host) {
      await handleEditSave(props.host, normalized)
    } else {
      await handleAdd(normalized)
    }
  } catch (e) {
    // store 业务错误（地址重复/名称超长等）按其 i18n key 显示；网络/解析失败统一提示
    formError.value = isHostStoreError(e)
      ? t(e.message, { max: HOST_NAME_MAX })
      : t('hosts.addCheckFailed')
  } finally {
    probing.value = false
  }
}

/** add 模式：探测 → 启用认证则二次认证，否则直接添加（不切换） */
async function handleAdd(normalized: string) {
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
}

/** edit 模式：仅改名直接保存；改地址先探活再保存（旧凭证由 store 清除） */
async function handleEditSave(host: HostConfig, normalized: string) {
  const urlChanged = host.url !== normalized
  if (urlChanged) {
    // 地址是新的：必须探活（GET /auth/status），不可达则不保存
    await hostsStore.probeHostUrl(normalized)
  }
  const needRefresh = hostsStore.updateHostInfo(host.id, {
    name: name.value,
    url: normalized,
  })
  message.success(t('hosts.editSuccess'))
  if (needRefresh) {
    // 当前主机改地址：current 键已同步，整页刷新按新地址重建（与切换主机同体验）
    window.location.assign('/')
    return
  }
  if (urlChanged) {
    // 非当前主机改地址：凭证已清除，下次切换时才重新登录，这里补一条可见提示
    message.info(t('hosts.editAddressChangedHint'))
  }
  emit('update:show', false)
}

/** 阶段 2 提交（add 模式）：登录目标主机，成功后把凭证存入主机记录并添加 */
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
    // 认证通过：凭证随主机记录一起持久化（用户名保存供下次自动填充）
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
      // addHostRecord 的重复地址/名称超长等业务错误
      authError.value = t(e.message, { max: HOST_NAME_MAX })
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

/** 认证失败后允许回退修改地址/名称（左上角返回按钮，仅 add 模式） */
function backToForm() {
  phase.value = 'form'
  authError.value = ''
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="props.mode === 'add' ? t('hosts.addTitle') : t('hosts.editTitle')"
    :mask-closable="true"
    style="width: 420px"
    @update:show="emit('update:show', $event)"
  >
    <!-- 基本信息：名称 + 地址（add/edit 共用） -->
    <form v-if="phase === 'form'" class="flex flex-col gap-4" @submit.prevent="handleSubmit">
      <n-input
        v-model:value="name"
        :placeholder="t('hosts.namePlaceholder')"
        :maxlength="HOST_NAME_MAX"
        size="large"
      />
      <n-input
        v-model:value="url"
        :placeholder="t('hosts.urlPlaceholder')"
        size="large"
        @keydown.enter.prevent="handleSubmit"
      />
      <p v-if="formError" class="text-sm text-red-500">{{ formError }}</p>
      <!-- 本地存储说明（添加/编辑共用；多主机数据仅存浏览器，见 utils/hostStorage） -->
      <p class="text-xs leading-relaxed text-ink-muted">{{ t('hosts.localOnlyHint') }}</p>
      <n-button
        type="primary"
        size="large"
        block
        attr-type="submit"
        :disabled="!canSubmit"
        :loading="probing"
      >
        {{ props.mode === 'add' ? t('common.next') : t('common.save') }}
      </n-button>
    </form>

    <!-- 二次认证（仅 add 模式、目标主机启用密码认证） -->
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