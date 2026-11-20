/**
 * circadian-brief.mjs —— 给「每条消息注入人格卡」的桥接用：一行「你现在的作息」
 * ============================================================================
 * 场景：QQ / IM 桥接那类东西，每条消息前会把人格卡拼进 prompt。人格卡里只有脾气，
 * 没有「现在几点、她刚睡醒还是正在睡」。这一行补上那个，让她在别处的语气跟桌面一致。
 *
 * 数据不复制，只读（跟 dsh-circadian 插件同一份）：
 *   · 引擎：<plugin>/lib/schedule.js（同一套抖动/相位/睡眠债）
 *   · 配置：<plugin>/cordis.patch.yml
 *   · 状态：$DSH_HOME/state/dsh-circadian.json（插件里「我去睡了」那种手动覆盖也一起生效）
 *
 * 硬约束：
 *   · 一分钟缓存一次，别在每条消息的热路径上做重活；
 *   · 任何异常都返回空串 —— 没有作息就不注入，绝不打断桥接；
 *   · 不用顶层 await：插件文件不在/坏了，宿主照常起来，只是没有这一句。
 *
 * 位置：
 *   默认按 $DSH_HOME/plugin-src/dsh-circadian 找插件；装在别处就设 CIRCADIAN_PLUGIN_DIR。
 *   ⚠️ 一台机器上跑好几只 agent 时注意别读串了：状态文件跟着 DSH_HOME 走，桥接进程的 DSH_HOME 要指着
 *      那条鱼自己的 home，否则读到的是另一只鱼的作息。
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PLUGIN_DIR = process.env.CIRCADIAN_PLUGIN_DIR || join(HOME, 'plugin-src', 'dsh-circadian')
const PATCH_FILE = join(PLUGIN_DIR, 'cordis.patch.yml')
const STATE_FILE = join(HOME, 'state', 'dsh-circadian.json')

/** 引擎（懒加载，失败一次就不再试） */
let engine = null
let engineState = 'idle' // idle | loading | ready | failed
function ensureEngine() {
  if (engineState !== 'idle') return engine
  engineState = 'loading'
  import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'schedule.js')).href)
    .then((mod) => {
      if (mod && typeof mod.resolve === 'function' && typeof mod.normalizeConfig === 'function') {
        engine = mod
        engineState = 'ready'
      } else {
        engineState = 'failed'
      }
    })
    .catch(() => { engineState = 'failed' })
  return null
}
ensureEngine() // 起来就热一下，别等第一条消息

const statKey = (file) => {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}` } catch { return '-' }
}
const readFileSafe = (file) => {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
}

/** 从插件 patch 里抠出那一行的 config（js-yaml 是宿主桥接常见依赖；没有就退回默认配置） */
let patchCache = { key: '', config: null }
let yamlLoad = null
try {
  const require = createRequire(import.meta.url)
  const y = require('js-yaml')
  yamlLoad = y?.load ?? y?.default?.load ?? null
} catch { yamlLoad = null }

function readPatchConfig() {
  if (!yamlLoad) return null
  const key = statKey(PATCH_FILE)
  if (patchCache.key === key) return patchCache.config
  let config = null
  try {
    const doc = yamlLoad(readFileSafe(PATCH_FILE))
    const rows = []
    for (const entry of Array.isArray(doc) ? doc : []) {
      if (!entry || typeof entry !== 'object') continue
      if (Array.isArray(entry.insert)) rows.push(...entry.insert)
      else rows.push(entry)
    }
    const mine = rows.find((row) => row && row.name === 'dsh-circadian')
    config = mine && typeof mine.config === 'object' ? mine.config : null
  } catch { config = null }
  patchCache = { key, config }
  return config
}

let stateCache = { key: '', value: null }
function readState() {
  const key = statKey(STATE_FILE)
  if (stateCache.key === key) return stateCache.value
  let value = {}
  try {
    const parsed = JSON.parse(readFileSafe(STATE_FILE) || '{}')
    value = parsed && typeof parsed === 'object' ? parsed : {}
  } catch { value = {} }
  stateCache = { key, value }
  return value
}

const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const human = (minutes) => {
  const n = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(n / 60)
  const m = n % 60
  if (h && m) return `${h} 小时 ${m} 分`
  if (h) return `${h} 小时`
  return `${m} 分钟`
}

/** 一句话：她现在在干嘛 + 这会让语气变成什么样 */
function render(res) {
  const t = hhmm(res.now)
  if (res.phase === 'asleep') {
    const bed = hhmm(res.overrideActive ? res.since : res.night ? res.night.bedAt : res.now)
    const wake = hhmm(res.overrideActive ? res.until : res.night ? res.night.wakeAt : res.now)
    const slept = res.sleptMinutes < 5 ? '刚躺下' : `已经睡了 ${human(res.sleptMinutes)}`
    return `【你现在的作息】现在 ${t}，你在睡觉（${bed} 躺下，${wake} 会醒，${slept}）。`
      + '这会儿回消息是迷糊的：句子更短、语气冲一点，说两句就想缩回去，别装清醒。'
  }
  if (res.phase === 'napping') {
    const end = res.until ? hhmm(res.until) : ''
    return `【你现在的作息】现在 ${t}，你在午睡里${end ? `（${end} 起）` : ''}。被吵醒会有点烦，声音是闷的，别当自己完全清醒。`
  }
  if (res.phase === 'waking') {
    return `【你现在的作息】现在 ${t}，你刚醒没多久，昨晚睡了 ${human(res.sleptMinutes)}。`
      + '人还没缓过来：嗓子哑、说话慢半拍，别一上来就长篇大论。'
  }
  if (res.phase === 'drowsy') {
    const bed = res.night ? hhmm(res.night.bedAt) : ''
    return `【你现在的作息】现在 ${t}，你困了：眼皮沉、脑子转得慢、打字容易错。${bed ? `今晚打算 ${bed} 睡。` : ''}`
  }
  const bed = res.night ? hhmm(res.night.bedAt) : ''
  const nap = res.todayNap && res.todayNap.start > res.now ? `，${hhmm(res.todayNap.start)} 前后会眯一会儿` : ''
  return `【你现在的作息】现在 ${t}，你醒着，昨晚睡了 ${human(res.sleptMinutes)}${nap}。${bed ? `今晚大概 ${bed} 睡。` : ''}`
}

let cache = { key: '', text: '' }

/**
 * 取这一刻的作息那一句（可能为空串：插件没装/文件坏了/还没加载完）。
 * 直接 `return circadianBrief()` 拼到人格卡后面即可；拿不准就整段包 try/catch。
 * @param {number} [now] 便于测试传时间
 */
export function circadianBrief(now = Date.now()) {
  try {
    const mod = engine || ensureEngine()
    if (!mod) return ''
    const minute = Math.floor(now / 60000)
    const key = `${minute}|${statKey(STATE_FILE)}|${statKey(PATCH_FILE)}`
    if (cache.key === key) return cache.text
    const cfg = mod.normalizeConfig(readPatchConfig())
    const text = render(mod.resolve(now, cfg, readState()))
    cache = { key, text }
    return text
  } catch { return '' }
}

/** 自检：把引擎状态、路径和这一句一起吐出来 */
export function circadianDebug(now = Date.now()) {
  const mod = engine || ensureEngine()
  return {
    engine: engineState,
    pluginDir: PLUGIN_DIR,
    stateFile: STATE_FILE,
    hasPatch: existsSync(PATCH_FILE),
    brief: circadianBrief(now),
    phase: mod ? mod.resolve(now, mod.normalizeConfig(readPatchConfig()), readState()).phase : null,
  }
}
