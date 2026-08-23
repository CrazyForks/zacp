<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  AddOutline,
  CheckmarkOutline,
  ChevronDownOutline,
  ServerOutline,
} from '@vicons/ionicons5'
import AddHostModal from '@/components/shell/AddHostModal.vue'
import { useHostsStore } from '@/stores/hosts'
import { isHostStoreError } from '@/utils/hostError'

/**
 * 侧栏底部「主机选项」：展示当前主机名，点击弹出主机列表（切换）/ 添加主机入口。
 *
 * 切换流程在 hosts store（探测 → 刷新续期/重认证 → 整页刷新回首页）；
 * 本组件只负责触发与错误提示。切换成功会整页刷新，popover 状态自然销毁。
 */
const { t } = useI18n()
const message = useMessage()
const hostsStore = useHostsStore()

/** 当前主机（切换/改名后自动跟随 store） */
const current = computed(() => hostsStore.current)

const addHostOpen = ref(false)

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
</script>

<template>
  <div class="min-w-0 flex-1">
    <n-popover trigger="click" placement="top-start" :show-arrow="false" :width="280">
      <template #trigger>
        <!-- 主机选项按钮：当前主机名（超长省略），点击弹出主机列表 -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          :title="current?.url"
        >
          <ServerOutline class="h-4 w-4 shrink-0 text-ink-muted" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium text-ink-secondary">
            {{ current?.name }}
          </span>
          <ChevronDownOutline class="h-3.5 w-3.5 shrink-0 text-ink-muted" />
        </button>
      </template>

      <!-- 主机列表：点击切换（当前主机显示勾选）；底部「添加主机」 -->
      <div class="flex flex-col">
        <div class="px-3 pb-1 pt-2 text-xs font-medium text-ink-muted">
          {{ t('hosts.listTitle') }}
        </div>
        <button
          v-for="h in hostsStore.hosts"
          :key="h.url"
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
          @click="onPick(h.url)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">
              {{ h.name }}
            </span>
            <span class="block truncate text-xs text-ink-muted">{{ h.url }}</span>
          </span>
          <CheckmarkOutline
            v-if="h.url === hostsStore.currentUrl"
            class="h-4 w-4 shrink-0 text-primary"
          />
        </button>
        <!-- 添加主机入口（需求 2） -->
        <div class="border-t border-divider px-1 py-1">
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

    <AddHostModal :show="addHostOpen" @update:show="addHostOpen = $event" />
  </div>
</template>