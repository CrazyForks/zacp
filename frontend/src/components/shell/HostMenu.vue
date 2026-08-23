<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  AddOutline,
  ChevronDownOutline,
  CreateOutline,
  ServerOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import HostFormModal from '@/components/shell/HostFormModal.vue'
import { useHostsStore } from '@/stores/hosts'
import { isHostStoreError } from '@/utils/hostError'
import type { HostConfig } from '@/utils/hostStorage'

/**
 * 侧栏底部「主机选项」：展示当前主机名，点击弹出主机列表。
 *
 * 行内操作：
 * - 行主体点击 = 切换主机（hosts store：探测 → 刷新续期/重认证 → 整页刷新回首页）；
 * - ✎ 编辑（非本地主机）= 打开编辑弹窗（改名/改地址，改地址需探活+清凭证）；
 * - 🗑 删除（非本地主机）= 确认后删除，删除当前主机自动切回本地主机；
 * - 本地主机（内置兜底）编辑/删除按钮置灰禁用。
 */
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const hostsStore = useHostsStore()

/** 当前主机（切换/改名后自动跟随 store） */
const current = computed(() => hostsStore.current)

/** 主机显示名：内置本地主机按当前语言显示（localStorage 中的存储值固定为「本地主机」） */
function hostDisplayName(h: HostConfig | undefined | null): string {
  if (!h) {
    return ''
  }
  return h.builtin ? t('hosts.localName') : h.name
}

/** 添加弹窗（HostFormModal add 模式）与编辑弹窗（edit 模式）开关 */
const addHostOpen = ref(false)
const editHostOpen = ref(false)
const editTarget = ref<HostConfig | null>(null)

async function onPick(url: string) {
  try {
    const switched = await hostsStore.switchHost(url)
    if (!switched) {
      // 用户取消了重认证弹窗：切换中止，保持现状（静默）
      return
    }
    // switched=true 时 hosts store 已触发整页刷新，此处无需任何操作
  } catch (e) {
    message.error(isHostStoreError(e) ? t(e.message) : t('hosts.switchCheckFailed'))
  }
}

function openAddHost() {
  addHostOpen.value = true
}

/** 打开编辑弹窗（仅非本地主机可达，按钮已禁用兜底） */
function openEditHost(h: HostConfig) {
  if (h.builtin) {
    return
  }
  editTarget.value = h
  editHostOpen.value = true
}

/** 删除确认（dialog.warning，避免 popover 内嵌 popconfirm 的层级问题） */
function confirmDeleteHost(h: HostConfig) {
  if (h.builtin) {
    return
  }
  const isCurrent = h.url === hostsStore.currentUrl
  dialog.warning({
    title: t('hosts.deleteTitle'),
    content: isCurrent
      ? t('hosts.deleteCurrentConfirm', { name: h.name })
      : t('hosts.deleteConfirm', { name: h.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      try {
        const needRefresh = hostsStore.removeHost(h.id)
        message.success(t('hosts.deleteSuccess'))
        if (needRefresh) {
          // 删除的是当前主机：store 已把 current 回退本地主机，整页刷新重建
          window.location.assign('/')
        }
      } catch (e) {
        message.error(isHostStoreError(e) ? t(e.message) : t('hosts.deleteFailed'))
      }
    },
  })
}
</script>

<template>
  <div class="min-w-0 flex-1">
    <n-popover trigger="click" placement="top-start" :show-arrow="false" :width="300">
      <template #trigger>
        <!-- 主机选项按钮：当前主机名（超长省略），点击弹出主机列表 -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          :title="current?.url"
        >
          <ServerOutline class="h-4 w-4 shrink-0 text-ink-muted" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink-secondary">
            {{ hostDisplayName(current) }}
          </span>
          <ChevronDownOutline class="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        </button>
      </template>

      <!-- 主机列表：行主体点击切换；选中行主色高亮背景；右侧编辑/删除（本地主机禁用） -->
      <div class="flex flex-col">
        <div class="px-3 pb-1 pt-2 text-xs font-medium text-ink-muted">
          {{ t('hosts.listTitle') }}
        </div>
        <div
          v-for="h in hostsStore.hosts"
          :key="h.id"
          class="flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors"
          :class="
            h.url === hostsStore.currentUrl
              ? 'bg-primary/10 hover:bg-primary/15'
              : 'hover:bg-surface-hover'
          "
        >
          <!-- 行主体：切换主机（独立 button，避免与操作按钮嵌套）。
               选中行 hover 保持主色加深而非变灰（hover:bg-primary/15），避免用户误以为失去选中态 -->
          <button
            type="button"
            class="min-w-0 flex-1 cursor-pointer py-0.5 text-left focus:outline-none"
            :title="t('hosts.switchAction')"
            @click="onPick(h.url)"
          >
            <span class="block truncate text-sm text-ink">
              {{ hostDisplayName(h) }}
            </span>
            <span class="block truncate text-xs text-ink-muted">{{ h.url }}</span>
          </button>
          <!-- 编辑：本地主机置灰禁用（title 说明原因） -->
          <span
            :title="h.builtin ? t('hosts.builtinProtected') : undefined"
            class="inline-flex"
          >
            <n-button
              quaternary
              circle
              size="tiny"
              :disabled="h.builtin"
              :aria-label="t('hosts.editAction')"
              @click="openEditHost(h)"
            >
              <template #icon>
                <CreateOutline />
              </template>
            </n-button>
          </span>
          <!-- 删除：本地主机置灰禁用 -->
          <span
            :title="h.builtin ? t('hosts.builtinProtected') : undefined"
            class="inline-flex"
          >
            <n-button
              quaternary
              circle
              size="tiny"
              :disabled="h.builtin"
              :aria-label="t('hosts.deleteAction')"
              @click="confirmDeleteHost(h)"
            >
              <template #icon>
                <TrashOutline />
              </template>
            </n-button>
          </span>
        </div>
        <!-- 添加主机入口（需求 2）：mt-2 使分割线与上方主机行（尤其选中高亮行）拉开距离，避免高亮背景紧贴分割线 -->
        <div class="mt-2 border-t border-divider px-1 py-1">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-ink-secondary transition-colors hover:bg-surface-hover"
            @click="openAddHost"
          >
            <AddOutline class="h-4 w-4 text-ink-muted" />
            {{ t('hosts.addAction') }}
          </button>
        </div>
      </div>
    </n-popover>

    <!-- 添加 / 编辑弹窗（add/edit 双模式共用表单，见 HostFormModal） -->
    <HostFormModal :show="addHostOpen" mode="add" @update:show="addHostOpen = $event" />
    <HostFormModal
      :show="editHostOpen"
      mode="edit"
      :host="editTarget"
      @update:show="editHostOpen = $event"
    />
  </div>
</template>