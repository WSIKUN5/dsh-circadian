/**
 * dsh-circadian —— 作息（宿主侧）
 * ============================================================================
 * 干四件事：
 *   ① 算：任何时候都能算出「这一刻她在干嘛」（睡着 / 刚醒 / 犯困 / 午睡 / 醒着）
 *   ② 说：把状态作为 systemPrompt 的 context 注入给她，她照着这个状态说话
 *   ③ 动：给她一个 circadian 工具，能自己说「我去睡了 / 起了 / 眯一会儿」
 *   ④ 给：/api/circadian 把状态交给界面那条作息条（client.js）
 *
 * 状态落盘在 $DSH_HOME/state/dsh-circadian.json（两条鱼各自一份，不会串）。
 * 计算全在 lib/schedule.js 里，纯函数，可以单独 node 跑。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  clock,
  contextText,
  dateKey,
  humanMinutes,
  minutesAsClock,
  normalizeConfig,
  resolve,
  statusLine,
} from './lib/schedule.js'

export const name = 'circadian'
export const inject = ['tools', 'webServer', 'agents']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(HOME, 'state')
const STATE_FILE = join(STATE_DIR, 'dsh-circadian.json')

const EMPTY_STATE = { schema: 1, override: null, history: [], woke: null }

const readState = () => {
  try {
    if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE }
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE }
    return {
      schema: 1,
      override: raw.override && typeof raw.override === 'object' ? raw.override : null,
      history: Array.isArray(raw.history) ? raw.history.slice(-30) : [],
      woke: raw.woke && typeof raw.woke === 'object' ? raw.woke : null,
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

const writeState = (state) => {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, STATE_FILE)
  } catch { /* 写不进去就算了：状态只是缓存，丢了下次重算 */ }
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = (m) => { try { ctx.logger?.info?.(`[circadian] ${m}`) } catch { /* 没 logger 就算了 */ } }

  let state = readState()
  let dirty = false
  const token = {} // 每次落盘换一个，用来判断"这次快照真的改了东西吗"

  /** 过期的手动覆盖就清掉（纯维护） */
  const pruneOverride = (now) => {
    if (state.override && Number(state.override.until) <= now) {
      state = { ...state, override: null }
      dirty = true
    }
  }

  /** 把"最近睡完的那一晚"记进历史，攒睡眠债用 */
  const rememberNight = (res) => {
    if (!res.past) return
    const last = state.history[state.history.length - 1]
    if (last && String(last.key) === String(res.past.key)) return
    state = {
      ...state,
      history: [
        ...state.history,
        {
          key: res.past.key,
          bedAt: res.past.bedAt,
          wakeAt: res.past.wakeAt,
          sleptMinutes: res.past.sleptMinutes,
          quality: res.night && res.night.key === res.past.key ? res.night.quality : null,
        },
      ].slice(-30),
    }
    dirty = true
  }

  /** 一次完整快照：算状态 → 顺手维护落盘 → 返回结果 */
  const snapshot = () => {
    const now = Date.now()
    pruneOverride(now)
    const res = resolve(now, cfg, state)
    rememberNight(res)
    if (dirty) { writeState(state); dirty = false }
    return res
  }

  // ── ② 注入：每个 agent 一份 context ───────────────────────────────────
  const wired = new Map() // agent -> disposer（插件自己也握一份，卸载时一起拆）

  const wireAgent = (agent) => {
    if (!agent || wired.has(agent)) return
    const sp = agent.ctx && agent.ctx.systemPrompt
    if (!sp || typeof sp.context !== 'function') return
    try {
      const dispose = agent.ctx.effect(() => {
        const d = sp.context({
          name: 'circadian',
          order: 880,
          text: () => {
            if (!cfg.inject) return ''
            try { return contextText(snapshot(), cfg) } catch { return '' }
          },
        })
        return () => { try { d() } catch { /* ignore */ } }
      }, 'circadian: 注入作息状态')
      wired.set(agent, dispose)
    } catch (e) {
      log(`挂注入失败：${e && e.message ? e.message : e}`)
    }
  }

  const unwireAgent = (agent) => {
    const dispose = wired.get(agent)
    if (!dispose) return
    wired.delete(agent)
    try { dispose() } catch { /* ignore */ }
  }

  try {
    ctx.on('agent/created', ({ agent }) => { wireAgent(agent) })
  } catch { /* 老内核没这个事件就算了 */ }
  try {
    const list = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    for (const a of list) wireAgent(a)
  } catch { /* ignore */ }
  try {
    // 插件卸载时把自己挂上去的那几份也拆掉（agent.ctx 的注册有两个主人）
    ctx.effect(() => () => { for (const a of [...wired.keys()]) unwireAgent(a) }, 'circadian: 卸载时拆注入')
  } catch { /* ignore */ }

  // ── 被吵醒计数：睡着时来了人话就记一笔 ───────────────────────────────
  try {
    ctx.on('agent/inbox/inserted', () => {
      try {
        const res = snapshot()
        if (res.phase !== 'asleep' && res.phase !== 'napping') return
        const key = res.night ? res.night.key : dateKey(Date.now())
        const prev = state.woke && String(state.woke.key) === String(key) ? state.woke : { key, count: 0, at: 0 }
        const now = Date.now()
        if (now - Number(prev.at || 0) < 5 * 60000) return // 五分钟内连着几条算一次
        state = { ...state, woke: { key, count: Number(prev.count || 0) + 1, at: now } }
        writeState(state)
      } catch { /* ignore */ }
    })
  } catch { /* 没有这个事件就算了 */ }

  // ── ③ 工具：她自己能睡、能起、能眯一会儿 ─────────────────────────────
  if (cfg.exposeTool) {
    try {
      ctx.effect(() => ctx.tools.register({
        name: 'circadian',
        description:
          '看自己现在的作息状态，或者真的去睡/起床/眯一会儿。' +
          'action=status 只看不改变任何东西；' +
          'action=sleep 表示你这就去睡了（之后被人叫醒会迷糊）；' +
          'action=wake 表示你起来了（赖床也算起来）；' +
          'action=nap 表示你躺下午睡一小会儿。' +
          '只在真的要改变状态时调用，别每轮都调；也不要在回复里念这些字段。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'sleep', 'wake', 'nap'],
              description: 'status 查询（默认）；sleep 去睡；wake 起来；nap 午睡。',
            },
          },
          required: [],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              phase: { type: 'string' },
              line: { type: 'string' },
              nextAt: { type: 'string' },
            },
          },
          render(_args, value) {
            const line = value && typeof value.line === 'string' ? value.line : ''
            return [{ type: 'text', text: line || '（没算出来）' }]
          },
        },
        async execute(args) {
          const action = String((args && args.action) || 'status')
          const now = Date.now()
          const before = snapshot()
          if (action === 'status') {
            return { ok: true, phase: before.phase, line: statusLine(before, cfg), nextAt: before.next ? clock(before.next.at) : '' }
          }
          let until = null
          let kind = 'sleep'
          if (action === 'sleep') {
            kind = 'sleep'
            // 现在躺下 → 下次自然醒（找不到就按八小时后）
            until = before.upcomingWake || now + 8 * 3600 * 1000
          } else if (action === 'wake') {
            kind = 'awake'
            until = before.upcomingBed || now + 16 * 3600 * 1000
          } else if (action === 'nap') {
            kind = 'nap'
            until = now + cfg.napMinutes * 60000
          } else {
            return { ok: false, phase: before.phase, line: `不认识的 action：${action}`, nextAt: '' }
          }
          state = { ...state, override: { kind, since: now, until } }
          writeState(state)
          const after = snapshot()
          const verb = action === 'sleep' ? '去睡了' : action === 'wake' ? '起来了' : '躺下午睡了'
          return {
            ok: true,
            phase: after.phase,
            line: `${verb}（${clock(now)}）——现在是「${after.label}」，${clock(until)} 会自然醒/起来。`,
            nextAt: clock(until),
          }
        },
      }), 'circadian: 工具')
    } catch (e) {
      log(`工具没挂上：${e && e.message ? e.message : e}`)
    }
  }

  // ── ④ 界面要的数据 ───────────────────────────────────────────────────
  const payload = () => {
    const res = snapshot()
    const now = Date.now()
    return {
      ok: true,
      now,
      clock: res.clock,
      dateKey: res.dateKey,
      phase: res.phase,
      label: res.label,
      since: res.since,
      until: res.until,
      next: res.next ? { kind: res.next.kind, at: res.next.at, inMinutes: Math.max(0, Math.round((res.next.at - now) / 60000)) } : null,
      sleptMinutes: res.sleptMinutes,
      debtMinutes: res.debtMinutes,
      wokeCount: res.wokeCount,
      night: res.night,
      todaysNap: res.todayNap,
      line: statusLine(res, cfg),
      sleepText: humanMinutes(res.sleptMinutes),
      // 自查用：这份状态到底注给了几个会话、注的原文是什么
      agentsWired: wired.size,
      injectedSample: cfg.inject ? contextText(res, cfg) : '（injectContext=false，不注入）',
      history: state.history.slice(-7).map((h) => ({
        key: h.key,
        sleptMinutes: h.sleptMinutes,
        quality: h.quality === undefined ? null : h.quality,
      })),
      config: {
        title: cfg.title,
        bedtime: minutesAsClock(cfg.bedtime),
        wakeTime: minutesAsClock(cfg.wakeTime),
        napEnabled: cfg.napEnabled,
        targetSleepHours: cfg.targetSleepHours,
      },
      override: state.override || null,
    }
  }

  const sendJson = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    } catch { /* 连接断了就算了 */ }
  }

  const readBody = (req) => new Promise((ok) => {
    let buf = ''
    let done = false
    const finish = () => { if (!done) { done = true; ok(buf) } }
    try {
      req.on('data', (chunk) => { buf += chunk; if (buf.length > 64 * 1024) { finish(); try { req.destroy() } catch { /* ignore */ } } })
      req.on('end', finish)
      req.on('error', finish)
      setTimeout(finish, 3000)
    } catch { finish() }
  })

  const handle = async (req, res) => {
    let pathname = ''
    try {
      const raw = String(req.url || '')
      const cut = raw.indexOf('?')
      pathname = cut >= 0 ? raw.slice(0, cut) : raw
    } catch { /* ignore */ }

    try {
      if (req.method === 'POST') {
        const text = await readBody(req)
        let body = {}
        try { body = text ? JSON.parse(text) : {} } catch { body = {} }
        const action = String(body && body.action ? body.action : 'sleep')
        const now = Date.now()
        const before = snapshot()
        let until = now + 8 * 3600 * 1000
        let kind = 'sleep'
        if (action === 'wake') {
          kind = 'awake'
          until = before.upcomingBed || now + 16 * 3600 * 1000
        } else if (action === 'nap') {
          kind = 'nap'
          until = now + cfg.napMinutes * 60000
        } else if (action === 'clear') {
          state = { ...state, override: null }
          writeState(state)
          return sendJson(res, 200, { ok: true, cleared: true, ...payload() })
        } else {
          kind = 'sleep'
          until = before.upcomingWake || now + 8 * 3600 * 1000
        }
        state = { ...state, override: { kind, since: now, until } }
        writeState(state)
        return sendJson(res, 200, payload())
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: `不支持 ${req.method}` })
      if (/\/act\/?$/.test(pathname)) return sendJson(res, 200, payload())
      return sendJson(res, 200, payload())
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }

  try {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/circadian', handler: handle }), 'circadian: /api/circadian 路由')
    log(`作息条数据：/api/circadian（状态文件 ${STATE_FILE}）`)
  } catch (e) {
    log(`路由没挂上：${e && e.message ? e.message : e}`)
  }

  return {
    status: () => payload(),
    config: () => cfg,
    state: () => state,
  }
}
