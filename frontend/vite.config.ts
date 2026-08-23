import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'

/**
 * Vite 配置。
 * Naive UI 按需引入（官方推荐）：
 * https://www.naiveui.com/zh-CN/os-theme/docs/import-on-demand
 * - unplugin-vue-components + NaiveUiResolver：模板中的 n-* 组件按需解析
 * - unplugin-auto-import：useMessage / useDialog 等组合式 API 按需注入
 * 组件请写在 template 里（n-button 等），不要在 script 里从 naive-ui 整包 import 组件。
 *
 * PWA（vite-plugin-pwa）：
 * - manifest：应用名 Zacp、主题色跟随系统明暗（浅 #0ea5e9 / 暗 #38bdf8）
 * - registerType: 'autoUpdate'：后台静默更新，下次启动用新版
 * - 离线策略 A：预缓存静态资源，能打开 UI 壳；实时 ACP 会话（WebSocket）本身
 *   需联网，离线无法继续，属聊天类产品常态。
 * - 图标源在 public/icons/（由 scripts/pwa-icons/main.go 从 ZacpAPP.jpg 派生）。
 */
export default defineConfig({
  base: '/',
  plugins: [
    vue(),
    tailwindcss(),
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        'pinia',
        'vue-i18n',
        {
          'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar'],
        },
      ],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [NaiveUiResolver()],
      dts: 'src/components.d.ts',
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Zacp',
        short_name: 'Zacp',
        description: '多 Agent ACP 网关（Web UI 接入多种支持 ACP 协议的 Agent 工具）',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0ea5e9',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // P0 优化：不把 442 个 JS 块全部 precache，仅缓存壳（html/css/小 JS），大块按需网络加载
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,mp3}'],
        globIgnores: [
          '**/mermaid*.js',
          '**/cytoscape*.js',
          '**/katex*.js',
          '**/emacs-lisp*.js',
          '**/cpp-*.js',
          '**/wasm-*.js',
          '**/codemirror*.js',
          '**/naive*.js',
          '**/xterm*.js',
        ],
        maximumFileSizeToCacheInBytes: 2.5 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/icons/'),
            handler: 'CacheFirst' as const,
            options: { cacheName: 'zacp-icons', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          // 大块运行时缓存：按需下载后缓存 30 天
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst' as const,
            options: { cacheName: 'zacp-assets', expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // P0 优化：手动分包，减少首屏预加载链长度
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/vue/') || id.includes('node_modules/vue-router') || id.includes('node_modules/pinia') || id.includes('node_modules/vue-i18n')) return 'vendor'
          if (id.includes('node_modules/naive-ui')) return 'naive'
          if (id.includes('node_modules/@xterm')) return 'xterm'
          if (id.includes('node_modules/@codemirror')) return 'codemirror'
          if (id.includes('node_modules/@incremark')) return 'incremark'
          if (id.includes('node_modules/mermaid')) return 'mermaid'
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8681,
    strictPort: true,
    proxy: {
      // 开发期把 REST/WS 前缀转到后端（默认 8680，与 config.toml / cmd/server 默认一致）
      '/api': {
        target: 'http://127.0.0.1:8680',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 8681,
    strictPort: true,
  },
})
