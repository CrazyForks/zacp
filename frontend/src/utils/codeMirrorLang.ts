/**
 * CodeMirror 6 语言推断：按文件扩展名 / 特殊文件名返回对应语言扩展。
 *
 * P0 优化：由静态 import 改为动态 import()，首屏不加载 15 个 lang-* 包，
 * 按需分 chunk（如 js/ts 首次打开时才下载 javascript 包），减少 1MB+ 首屏体积。
 * 带缓存：同一语言多次打开仅加载一次。
 */
import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'

type LangLoader = () => Promise<Extension>

// 缓存已加载的语言扩展，避免重复 import
const langCache = new Map<string, Extension>()

async function loadWithCache(key: string, loader: () => Promise<Extension>): Promise<Extension> {
  const cached = langCache.get(key)
  if (cached) return cached
  const ext = await loader()
  langCache.set(key, ext)
  return ext
}

const loaders: Record<string, LangLoader> = {
  // JS/TS 系列
  js: () => loadWithCache('js', () => import('@codemirror/lang-javascript').then((m) => m.javascript())),
  jsx: () => loadWithCache('jsx', () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true }))),
  mjs: () => loadWithCache('mjs', () => import('@codemirror/lang-javascript').then((m) => m.javascript())),
  cjs: () => loadWithCache('cjs', () => import('@codemirror/lang-javascript').then((m) => m.javascript())),
  ts: () => loadWithCache('ts', () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true }))),
  tsx: () => loadWithCache('tsx', () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true }))),
  json: () => loadWithCache('json', () => import('@codemirror/lang-json').then((m) => m.json())),
  jsonc: () => loadWithCache('jsonc', () => import('@codemirror/lang-json').then((m) => m.json())),
  // 常用后端/脚本语言
  py: () => loadWithCache('py', () => import('@codemirror/lang-python').then((m) => m.python())),
  pyw: () => loadWithCache('pyw', () => import('@codemirror/lang-python').then((m) => m.python())),
  go: () => loadWithCache('go', () => import('@codemirror/lang-go').then((m) => m.go())),
  rs: () => loadWithCache('rs', () => import('@codemirror/lang-rust').then((m) => m.rust())),
  c: () => loadWithCache('c', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  h: () => loadWithCache('h', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  cpp: () => loadWithCache('cpp', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  hpp: () => loadWithCache('hpp', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  cc: () => loadWithCache('cc', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  cxx: () => loadWithCache('cxx', () => import('@codemirror/lang-cpp').then((m) => m.cpp())),
  java: () => loadWithCache('java', () => import('@codemirror/lang-java').then((m) => m.java())),
  php: () => loadWithCache('php', () => import('@codemirror/lang-php').then((m) => m.php())),
  // 标记 / 样式
  md: () => loadWithCache('md', () => import('@codemirror/lang-markdown').then((m) => m.markdown())),
  markdown: () => loadWithCache('markdown', () => import('@codemirror/lang-markdown').then((m) => m.markdown())),
  mdx: () => loadWithCache('mdx', () => import('@codemirror/lang-markdown').then((m) => m.markdown())),
  html: () => loadWithCache('html', () => import('@codemirror/lang-html').then((m) => m.html())),
  htm: () => loadWithCache('htm', () => import('@codemirror/lang-html').then((m) => m.html())),
  vue: () => loadWithCache('vue', () => import('@codemirror/lang-html').then((m) => m.html())),
  css: () => loadWithCache('css', () => import('@codemirror/lang-css').then((m) => m.css())),
  scss: () => loadWithCache('scss', () => import('@codemirror/lang-sass').then((m) => m.sass({ indented: false }))),
  sass: () => loadWithCache('sass-indented', () => import('@codemirror/lang-sass').then((m) => m.sass({ indented: true }))),
  less: () => loadWithCache('less', () => import('@codemirror/lang-less').then((m) => m.less())),
  xml: () => loadWithCache('xml', () => import('@codemirror/lang-xml').then((m) => m.xml())),
  svg: () => loadWithCache('svg', () => import('@codemirror/lang-xml').then((m) => m.xml())),
  // 配置 / 数据
  sql: () => loadWithCache('sql', () => import('@codemirror/lang-sql').then((m) => m.sql())),
  yml: () => loadWithCache('yml', () => import('@codemirror/lang-yaml').then((m) => m.yaml())),
  yaml: () => loadWithCache('yaml', () => import('@codemirror/lang-yaml').then((m) => m.yaml())),
  toml: () =>
    loadWithCache('toml', () =>
      import('@codemirror/legacy-modes/mode/toml').then((m) => StreamLanguage.define(m.toml)),
    ),
  ini: () =>
    loadWithCache('ini', () =>
      import('@codemirror/legacy-modes/mode/properties').then((m) => StreamLanguage.define(m.properties)),
    ),
  conf: () =>
    loadWithCache('conf', () =>
      import('@codemirror/legacy-modes/mode/properties').then((m) => StreamLanguage.define(m.properties)),
    ),
  properties: () =>
    loadWithCache('properties', () =>
      import('@codemirror/legacy-modes/mode/properties').then((m) => StreamLanguage.define(m.properties)),
    ),
  env: () =>
    loadWithCache('env', () =>
      import('@codemirror/legacy-modes/mode/properties').then((m) => StreamLanguage.define(m.properties)),
    ),
  // 脚本 / 运维
  sh: () =>
    loadWithCache('sh', () =>
      import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
    ),
  bash: () =>
    loadWithCache('bash', () =>
      import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
    ),
  zsh: () =>
    loadWithCache('zsh', () =>
      import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
    ),
  ps1: () =>
    loadWithCache('ps1', () =>
      import('@codemirror/legacy-modes/mode/powershell').then((m) => StreamLanguage.define(m.powerShell)),
    ),
  nginx: () =>
    loadWithCache('nginx', () =>
      import('@codemirror/legacy-modes/mode/nginx').then((m) => StreamLanguage.define(m.nginx)),
    ),
}

const specialLoaders: Record<string, LangLoader> = {
  dockerfile: () =>
    loadWithCache('dockerfile', () =>
      import('@codemirror/legacy-modes/mode/dockerfile').then((m) => StreamLanguage.define(m.dockerFile)),
    ),
}

/** 按文件路径推断 CM6 语言；无法识别时返回 null（编辑器按纯文本处理） */
export async function detectLanguage(path: string): Promise<Extension | null> {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const special = specialLoaders[name]
  if (special) {
    try {
      return await special()
    } catch {
      return null
    }
  }
  const idx = name.lastIndexOf('.')
  if (idx < 0) return null
  const ext = name.slice(idx + 1)
  const loader = loaders[ext]
  if (!loader) return null
  try {
    return await loader()
  } catch {
    return null
  }
}

/** 同步版本（无语言高亮），供无需等待的场景；实际高亮由异步版本按需加载 */
export function detectLanguageSync(path: string): Extension | null {
  // 轻量同步判断：仅用于是否需要异步加载的快速分支，始终返回 null 让调用方走异步
  void path
  return null
}
