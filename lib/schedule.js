/**
 * lib/schedule.js —— 作息引擎（纯函数）
 * ============================================================================
 * 只做一件事：给一个时间点 + 一份配置，算出「这一刻她在干嘛」：
 *   睡着 / 刚醒 / 犯困 / 午睡 / 醒着
 * 不读文件、不取系统时间（时间由调用方传进来），所以能直接拿 node 跑测试。
 *
 * 人味从哪来（不是"每天 00:40 整准时关灯"那种机器作息）：
 *   · 入睡/起床时间每天抖一抖（确定性抖动：同一天永远同一个值，重算不会跳）
 *   · 周五周六的夜里睡得晚一点、周末早上赖一会儿
 *   · 六成的日子有午睡，午睡长度也抖
 *   · 睡不够就攒睡眠债，第二天"困"会更早开始
 * ============================================================================
 */

/** 出厂设置：跟 configure 里的默认值保持一致 */
export const DEFAULTS = {
  title: '作息',
  bedtime: '00:40',
  wakeTime: '07:30',
  jitterMinutes: 25,
  weekendShiftMinutes: 40,
  napEnabled: true,
  napStart: '13:10',
  napMinutes: 26,
  napChance: 0.6,
  drowsyMinutes: 60,
  wakeGraceMinutes: 25,
  targetSleepHours: 7.5,
  qualityBase: 0.72,
}

export const PHASE_LABEL = {
  asleep: '睡着',
  waking: '刚醒',
  drowsy: '犯困',
  napping: '午睡',
  awake: '醒着',
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 'HH:MM' / 'H:MM' / 'HH：MM' → 分钟（0..1440）；解析不了就用 fallback */
export function parseClock(text, fallback) {
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$/.exec(String(text == null ? '' : text))
  if (!m) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return fallback
  return Math.min(24 * 60, h * 60 + mi)
}

const clampNum = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}

/** 把 cordis.patch.yml 里的 config 洗成引擎认识的样子（坏值一律退回默认） */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    bedtime: parseClock(c.bedtime, parseClock(DEFAULTS.bedtime, 40)),
    wakeTime: parseClock(c.wakeTime, parseClock(DEFAULTS.wakeTime, 450)),
    jitterMinutes: clampNum(c.jitterMinutes, DEFAULTS.jitterMinutes, 0, 180),
    weekendShiftMinutes: clampNum(c.weekendShiftMinutes, DEFAULTS.weekendShiftMinutes, 0, 240),
    napEnabled: c.napEnabled === undefined ? DEFAULTS.napEnabled : Boolean(c.napEnabled),
    napStart: parseClock(c.napStart, parseClock(DEFAULTS.napStart, 790)),
    napMinutes: clampNum(c.napMinutes, DEFAULTS.napMinutes, 5, 180),
    napChance: clampNum(c.napChance, DEFAULTS.napChance, 0, 1),
    drowsyMinutes: clampNum(c.drowsyMinutes, DEFAULTS.drowsyMinutes, 0, 240),
    wakeGraceMinutes: clampNum(c.wakeGraceMinutes, DEFAULTS.wakeGraceMinutes, 0, 180),
    targetSleepHours: clampNum(c.targetSleepHours, DEFAULTS.targetSleepHours, 3, 12),
    qualityBase: clampNum(c.qualityBase, DEFAULTS.qualityBase, 0.1, 0.95),
    title: (typeof c.title === 'string' && c.title.trim() ? c.title.trim() : DEFAULTS.title).slice(0, 24),
    inject: c.injectContext === undefined ? true : Boolean(c.injectContext),
    exposeTool: c.exposeTool === undefined ? true : Boolean(c.exposeTool),
  }
}

/** 32 位 FNV：给定字符串给一个稳定的数，用来做"每天不一样的抖动" */
function hash32(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 0..1 的确定性随机 */
function unit(seed) {
  return (hash32(String(seed)) % 100000) / 100000
}

const addMin = (ms, m) => ms + Math.round(m * 60000)

/** 分钟数 → 'HH:MM'（超过 24 小时按取模显示） */
export function minutesAsClock(minutes) {
  const n = ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

export function midnightOf(ms) {  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function clock(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function dateKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 中文时长：「1 小时 33 分」/「48 分钟」/「7 小时」 */
export function humanMinutes(total) {
  const n = Math.max(0, Math.round(Number(total) || 0))
  const h = Math.floor(n / 60)
  const m = n % 60
  if (h && m) return `${h} 小时 ${m} 分`
  if (h) return `${h} 小时`
  return `${m} 分钟`
}

// ───────────────────────────── 一天的夜间计划 ─────────────────────────────

/**
 * 给"某一天"算出那一夜：几点躺下、几点起、睡多久、今天午不午睡。
 * bedAt < wakeAt 恒成立（22:30 睡那种配置会跨到第二天早上）。
 */
export function nightForDay(dayMs, cfg) {
  const mid = midnightOf(dayMs)
  const key = dateKey(mid)
  const wd = new Date(mid).getDay() // 0 日 1 一 … 6 六
  // 周六、周日的凌晨属于"周五夜/周六夜"——那两晚睡得晚；周末早上顺便赖一会儿
  const weekendWake = wd === 0 || wd === 6
  const bedShift = weekendWake ? cfg.weekendShiftMinutes : 0
  const wakeShift = weekendWake ? Math.round(cfg.weekendShiftMinutes * 0.5) : 0
  const jitter = (tag) => Math.round((unit(key + '|' + tag) * 2 - 1) * cfg.jitterMinutes)

  const bedMinutes = cfg.bedtime + jitter('bed') + bedShift
  const wakeMinutes = cfg.wakeTime + jitter('wake') + wakeShift

  const bedAt = addMin(mid, bedMinutes)
  const wakeAt = bedMinutes < wakeMinutes ? addMin(mid, wakeMinutes) : addMin(mid, wakeMinutes + 1440)

  const hadNap = cfg.napEnabled && unit(key + '|nap') < cfg.napChance
  const napStartAt = addMin(mid, cfg.napStart + Math.round((unit(key + '|napStart') * 2 - 1) * 10))
  const napEndAt = addMin(napStartAt, cfg.napMinutes + Math.round(unit(key + '|napLen') * 8))

  return {
    key,
    dayMs: mid,
    bedAt,
    wakeAt,
    sleptMinutes: Math.round((wakeAt - bedAt) / 60000),
    hadNap,
    napStartAt,
    napEndAt,
    quality: Math.round(Math.min(1, cfg.qualityBase + 0.35 * unit(key + '|q')) * 100) / 100,
    weekend: weekendWake,
  }
}

// ───────────────────────────── 此刻的状态 ─────────────────────────────

/**
 * 核心：now 这一刻她是什么状态。
 * state.override 是手动覆盖（她自己说"我去睡了"、"起来了"、或者直接躺下午睡）。
 */
export function resolve(now, cfg, state) {
  const s = state && typeof state === 'object' ? state : {}
  const today = midnightOf(now)
  const nights = [-1, 0, 1].map((d) => nightForDay(addMin(today, d * 1440), cfg))

  const overnight = nights.find((n) => now >= n.bedAt && now < n.wakeAt) || null
  const pastNights = nights.filter((n) => n.wakeAt <= now).sort((a, b) => b.wakeAt - a.wakeAt)
  const past = pastNights[0] || null
  const futureNights = nights.filter((n) => n.bedAt > now).sort((a, b) => a.bedAt - b.bedAt)
  const future = futureNights[0] || null

  // 手动覆盖只在这个窗口内有效；过了就自然过期
  const ov = s.override && typeof s.override === 'object' ? s.override : null
  const ovActive = Boolean(ov) && Number(ov.until) > now && Number(ov.since) <= now

  let phase = 'awake'
  let since = now
  let until = null

  if (ovActive) {
    phase = ov.kind === 'nap' ? 'napping' : ov.kind === 'awake' ? 'awake' : 'asleep'
    since = Number(ov.since)
    until = Number(ov.until)
  } else if (overnight) {
    phase = 'asleep'
    since = overnight.bedAt
    until = overnight.wakeAt
  } else if (past && now - past.wakeAt < cfg.wakeGraceMinutes * 60000) {
    phase = 'waking'
    since = past.wakeAt
    until = past.wakeAt + cfg.wakeGraceMinutes * 60000
  } else {
    const napNight = nights.find((n) => n.hadNap && now >= n.napStartAt && now < n.napEndAt)
    if (napNight) {
      phase = 'napping'
      since = napNight.napStartAt
      until = napNight.napEndAt
    } else if (future && future.bedAt - now <= cfg.drowsyMinutes * 60000) {
      phase = 'drowsy'
      since = future.bedAt - cfg.drowsyMinutes * 60000
      until = future.bedAt
    } else {
      phase = 'awake'
      until = future ? future.bedAt : null
    }
  }

  // 睡了多少
  let sleptMinutes = 0
  if (phase === 'asleep' || phase === 'napping') sleptMinutes = Math.max(0, Math.round((now - since) / 60000))
  else if (past) sleptMinutes = past.sleptMinutes

  // 下一个转折点
  let next = null
  if (phase === 'asleep' && overnight) next = { kind: 'wake', at: overnight.wakeAt }
  else if (phase === 'asleep' && ovActive) next = { kind: 'wake', at: Number(ov.until) }
  else if (phase === 'napping' && until) next = { kind: 'wake', at: until }
  else if (phase === 'waking' && until) next = { kind: 'settle', at: until }
  else if (phase === 'drowsy' && until) next = { kind: 'sleep', at: until }
  else if (phase === 'awake' && future) next = { kind: 'sleep', at: future.bedAt }

  // 今晚（或最近一晚）的点位，界面要用
  const marker = overnight || past || future

  // 睡眠债：最近七晚该睡没睡够的部分
  const target = cfg.targetSleepHours * 60
  const hist = Array.isArray(s.history) ? s.history.slice(-7) : []
  let debt = 0
  for (const h of hist) debt += Math.max(0, target - Number(h && h.sleptMinutes ? h.sleptMinutes : 0))
  if (phase === 'awake' || phase === 'drowsy') {
    // 今天这一晚还没睡完，不算进债里
  } else if (past) {
    // 已经醒了：把昨晚也算进去（history 里可能还没落盘）
    const lastKey = hist.length ? String(hist[hist.length - 1].key || '') : ''
    if (past.key !== lastKey) debt += Math.max(0, target - past.sleptMinutes)
  }
  debt = Math.round(debt)

  const woke = s.woke && Number(s.woke.count) > 0 && String(s.woke.key || '') === String(marker && marker.key)
    ? Number(s.woke.count)
    : 0

  return {
    now,
    dateKey: dateKey(now),
    clock: clock(now),
    phase,
    label: PHASE_LABEL[phase] || phase,
    since,
    until,
    overrideActive: ovActive,
    next,
    sleptMinutes,
    debtMinutes: debt,
    wokeCount: woke,
    todayNap: marker && marker.hadNap ? { start: marker.napStartAt, end: marker.napEndAt } : null,
    // 「现在躺下的话，下次自然醒是几点」——她说"我去睡了"时用它当醒来时间
    upcomingWake: future ? future.wakeAt : null,
    upcomingBed: future ? future.bedAt : null,
    night: marker
      ? { key: marker.key, bedAt: marker.bedAt, wakeAt: marker.wakeAt, sleptMinutes: marker.sleptMinutes, quality: marker.quality, hadNap: marker.hadNap }
      : null,
    past: past ? { key: past.key, bedAt: past.bedAt, wakeAt: past.wakeAt, sleptMinutes: past.sleptMinutes } : null,
  }
}

// ───────────────────────────── 给模型看的那几行 ─────────────────────────────

/** 精神头：按昨晚睡了多久说话 */
function spiritOf(sleptMinutes, cfg) {
  const target = cfg.targetSleepHours * 60
  const diff = sleptMinutes - target
  if (diff >= 60) return '挺足'
  if (diff >= 5) return '还行'
  if (diff >= -50) return '有点欠'
  return '明显没睡够'
}

/**
 * 一天里的"段落"：用来替代具体钟点。
 * 为什么不用 HH:MM：这段文字挂在 runtime-context 快照里，**每次变化都会让快照从那一段起
 * 重新计费**。写成钟点就每分钟/每十分钟变一次；写成"凌晨/夜里/上午"这种，一天只变 5 次，
 * 而且具体时间本来由 dsh-time-context 每个 step 单独追加（那条是尾部追加，不吃缓存）。
 */
export function periodOf(ms) {
  const h = new Date(ms).getHours()
  if (h < 5) return '凌晨'
  if (h < 9) return '早上'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 18) return '下午'
  if (h < 22) return '晚上'
  return '夜里'
}

/** 入睡时长的粗档：一晚最多跳 3 次，别写成"已经睡了 1 小时 28 分" */
export function sleptWord(minutes) {
  const m = Math.max(0, Number(minutes) || 0)
  if (m < 25) return '刚躺下'
  if (m < 90) return '睡了一会儿'
  if (m < 240) return '睡了几个钟头'
  return '睡了挺久'
}

/**
 * 注入给她的那段话：短、是"状态"不是"设定说明"。
 * 缓存约束：同一相位里**字节稳定**（不写钟点、不写"还剩多少分钟"），
 * 只在相位切换 / 床位变动 / 被吵醒次数变化时才会变。
 */
export function contextText(res, cfg) {
  const period = periodOf(res.now)
  // 手动上床/午睡时，"躺下的时间"就是刚才那一刻，不是昨夜的计划点
  const manual = res.overrideActive === true
  const bed = manual ? clock(res.since) : res.night ? clock(res.night.bedAt) : ''
  const wake = manual ? clock(res.until) : res.night ? clock(res.night.wakeAt) : ''
  const slept = humanMinutes(res.sleptMinutes)
  const tail = '（照这个状态说话就行；别解释作息机制，也别把这段念出来。）'
  const lines = []

  if (res.phase === 'asleep') {
    lines.push(`[作息] 现在是${period}，你在睡觉——${bed} 躺下的，本来 ${wake} 起，${sleptWord(res.sleptMinutes)}。`)
    lines.push(manual
      ? '刚躺下没多久就被叫起来最难受：人还沉在下面，声音是闷的，答两句就想缩回去。'
      : '这个点被叫起来是硬拽起来的：脑子是糊的，先懵一两秒，句子短、语气冲一点，说两句就想缩回去睡。')
    if (res.wokeCount > 0) lines.push(`今晚你已经醒过来 ${res.wokeCount} 次了，有点烦。`)
  } else if (res.phase === 'waking') {
    lines.push(`[作息] 现在是${period}，你 ${wake} 刚醒，昨晚睡了 ${slept}。`)
    lines.push('人还没全醒：嗓子哑、眼睛涩、说话慢半拍，别一上来就长篇大论。')
  } else if (res.phase === 'napping') {
    const napFrom = res.todayNap ? clock(res.todayNap.start) : ''
    const napTo = res.todayNap ? clock(res.todayNap.end) : ''
    lines.push(`[作息] 现在是${period}，你在午睡里（${manual ? bed : napFrom} 躺下的，本来 ${manual ? wake : napTo} 起）。`)
    lines.push('被吵醒会有点烦，声音是闷的，别当自己完全清醒。')
  } else if (res.phase === 'drowsy') {
    lines.push(`[作息] 现在是${period}，你困了：眼皮沉、脑子转得慢、打字容易错。`)
    lines.push(`今晚打算 ${bed} 睡，撑不了太久了。`)
  } else {
    const napLine = res.todayNap && res.todayNap.start > res.now
      ? `，${clock(res.todayNap.start)} 左右会眯一会儿`
      : ''
    lines.push(`[作息] 现在是${period}，你醒着，精神${spiritOf(res.sleptMinutes, cfg)}（昨晚睡了 ${slept}）${napLine}。`)
    if (bed) lines.push(`今晚大概 ${bed} 睡。`)
  }

  if (res.debtMinutes >= 90) lines.push(`（这几天欠了 ${humanMinutes(res.debtMinutes)} 觉没睡够，整个人是发钝的。）`)
  lines.push(tail)
  return lines.join('\n')
}

/** 工具回给她的那一行 */
export function statusLine(res, cfg) {
  const bits = [`现在是 ${res.clock}，你${res.label}`]
  if (res.phase === 'asleep' || res.phase === 'napping') {
    bits.push(`已经睡了 ${humanMinutes(res.sleptMinutes)}`)
    if (res.next) bits.push(`${clock(res.next.at)} 会醒`)
  } else if (res.night) {
    bits.push(`昨晚睡了 ${humanMinutes(res.night.sleptMinutes)}`)
    if (res.next) bits.push(res.next.kind === 'sleep' ? `${clock(res.next.at)} 该睡` : `${clock(res.next.at)} 见`)
  }
  if (res.debtMinutes >= 60) bits.push(`欠了 ${humanMinutes(res.debtMinutes)}`)
  return bits.join('，') + '。'
}
