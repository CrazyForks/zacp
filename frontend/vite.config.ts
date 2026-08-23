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
        // P0 优化：壳 precache + 重块 runtimeCache，避免 343 文件 8MB 全量预缓存阻塞 SW 安装
        // - 仅预缓存 html/css/图标/音效等壳资源（~7 项，<200KB），JS 全部走 runtimeCaching 按需缓存
        // - 首屏 vendor/index/incremark 等仍通过浏览器 modulepreload 加载，离线后由 runtime CacheFirst 兜底
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,mp3}'],
        globIgnores: [
          '**/assets/**', // 全部 JS/CSS chunk 按需缓存，不预缓存；避免 200+ 语言/主题包 8MB 爆体积
        ],
        maximumFileSizeToCacheInBytes: 1 * 1024 * 1024,
        navigateFallback: '/index.html',
        // 避免预缓存带 hash 的 asset 被旧 SW 误判为更新风暴
        dontCacheBustURLsMatching: /assets\/.*\.[a-f0-9]{8}\.(js|css)$/,
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/icons/'),
            handler: 'CacheFirst' as const,
            options: { cacheName: 'zacp-icons', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          // JS/CSS 按需缓存：StaleWhileRevalidate 保证首屏总走网络最新，离线回退缓存
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/assets/'),
            handler: 'StaleWhileRevalidate' as const,
            options: {
              cacheName: 'zacp-assets',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // P0 优化：手动分包 + 首屏 modulePreload 过滤 + PWA 按需缓存
  build: {
    chunkSizeWarningLimit: 600,
    modulePreload: {
      polyfill: true,
      // 首屏 html 仅预加载 vendor/naive/incremark 等壳；mermaid/codemirror/xterm/katex 等重块按需加载，避免 3MB mermaid 阻塞 LCP
      resolveDependencies(_filename, deps, { hostType }) {
        if (hostType !== 'html') return deps
        // 过滤首屏不需要预加载的重型分包（已 manualChunks 拆出，按需动态 import）
        const heavy = /assets\/(mermaid|codemirror|xterm|katex|cytoscape|wasm|cpp|emacs-lisp)-.*\.js$/
        const heavy2 = /(mermaid|codemirror|xterm|katex)/i
        return deps.filter((d) => !heavy.test(d) && !heavy2.test(d))
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/vue/') || id.includes('node_modules/vue-router') || id.includes('node_modules/pinia') || id.includes('node_modules/vue-i18n')) return 'vendor'
          if (id.includes('node_modules/naive-ui')) return 'naive'
          if (id.includes('node_modules/@xterm')) return 'xterm'
          if (id.includes('node_modules/@codemirror')) return 'codemirror'
          if (id.includes('node_modules/@incremark')) return 'incremark'
          if (id.includes('node_modules/mermaid')) return 'mermaid'
          if (id.includes('node_modules/katex')) return 'katex'
          if (id.includes('node_modules/cytoscape')) return 'cytoscape'
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
