<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MoonOutline, SettingsOutline, SunnyOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import HostMenu from '@/components/shell/HostMenu.vue'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()
const emit = defineEmits<{ (e: 'open-settings'): void }>()

/** 主题图标与 tooltip 文案：显示当前模式（浅色=太阳，深色=月亮），点击切换 */
const themeIcon = computed(() => (appStore.isDark ? MoonOutline : SunnyOutline))
const themeTooltip = computed(() =>
  appStore.isDark ? t('settings.switchToLight') : t('settings.switchToDark'),
)
</script>

<template>
  <!-- 侧栏底部：左 [主机选项] 右 [暗色按钮][设置]（需求 2；头像区已移除） -->
  <div
    class="flex shrink-0 items-center gap-1 border-t border-divider px-3 py-2.5"
  >
    <HostMenu />
    <!-- 主题切换：齿轮左侧，图标显示当前模式（太阳=浅色/月亮=深色），点击互切 -->
    <n-tooltip trigger="hover">
      <template #trigger>
        <n-button
          quaternary
          circle
          size="small"
          :aria-label="themeTooltip"
          @click="appStore.toggleTheme()"
        >
          <template #icon>
            <n-icon><component :is="themeIcon" /></n-icon>
          </template>
        </n-button>
      </template>
      {{ themeTooltip }}
    </n-tooltip>
    <!-- 设置：仅 lg 及以上显示。移动端（<lg）隐藏——设置弹窗为固定大尺寸布局（SettingsModal），
         在手机上不兼容，且抽屉顶部已有其他入口；主题切换保留（无弹窗，直接生效）。 -->
    <div class="hidden lg:block">
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button
            quaternary
            circle
            size="small"
            @click="emit('open-settings')"
          >
            <template #icon>
              <n-icon><SettingsOutline /></n-icon>
            </template>
          </n-button>
        </template>
        {{ t('shell.settings') }}
      </n-tooltip>
    </div>
  </div>
</template>