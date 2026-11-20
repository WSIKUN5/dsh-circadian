/**
 * test/schedule-check.mjs —— 作息引擎自检（不依赖宿主，直接 node 跑）
 *   node test/schedule-check.mjs
 */
import assert from 'node:assert/strict'
import {
  clock,
  contextText,
  dateKey,
  minutesAsClock,
  nightForDay,
  normalizeConfig,
  parseClock,
  periodOf,
  resolve,
  sleptWord,
  statusLine,
} from '../lib/schedule.js'

const cfg = normalizeConfig({
  bedtime: '00:40',
  wakeTime: '07:30',
  jitterMinutes: 25,
  weekendShiftMinutes: 40,
  napEnabled: true,
  napStart: '13:10',
  napMinutes: 26,
  wakeGraceMinutes: 25,
  drowsyMinutes: 60,
  targetSleepHours: 7.5,
})

/** 造一个"本地时间"的时间戳，day 用 2026-11-<day> */
const at = (day, hh, mm) => new Date(2026, 10, day, hh, mm, 0, 0).getTime()

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['✓', name]) }
  catch (e) { results.push(['✗', name + ' — ' + (e && e.message ? e.message : e)]); process.exitCode = 1 }
}

check('parseClock 认 HH:MM 与全角冒号', () => {
  assert.equal(parseClock('00:40', -1), 40)
  assert.equal(parseClock('7:30', -1), 450)
  assert.equal(parseClock('13：10', -1), 790)
  assert.equal(parseClock('99:99', -1), -1)
})

check('minutesAsClock 回得去', () => {
  assert.equal(minutesAsClock(40), '00:40')
  assert.equal(minutesAsClock(450), '07:30')
  assert.equal(minutesAsClock(1470), '00:30')
})

check('同一天的计划是稳定的（重算不跳）', () => {
  const a = nightForDay(at(20, 12, 0), cfg)
  const b = nightForDay(at(20, 12, 0), cfg)
  assert.equal(a.bedAt, b.bedAt)
  assert.equal(a.wakeAt, b.wakeAt)
  assert.equal(a.hadNap, b.hadNap)
})

check('不同的日子抖动不同（不是每天一个点）', () => {
  const beds = new Set()
  for (let d = 15; d <= 21; d++) beds.add(nightForDay(at(d, 12, 0), cfg).bedAt)
  assert.ok(beds.size >= 3, `七天里只有 ${beds.size} 个不同的入睡点，看着太像定时任务了`)
})

check('每晚都睡够 5 小时以上、12 小时以内（配置合理时不崩）', () => {
  for (let d = 15; d <= 21; d++) {
    const n = nightForDay(at(d, 12, 0), cfg)
    assert.ok(n.sleptMinutes > 300 && n.sleptMinutes < 720, `${n.key} 睡了 ${n.sleptMinutes} 分钟`)
  }
})

check('躺下之后判定为睡着', () => {
  const night = nightForDay(at(20, 12, 0), cfg)
  const r = resolve(night.bedAt + 30 * 60000, cfg, {})
  assert.equal(r.phase, 'asleep')
  assert.ok(r.next && r.next.kind === 'wake')
})

check('临睡前一刻判定为犯困，不是睡着', () => {
  const night = nightForDay(at(20, 12, 0), cfg)
  const r = resolve(night.bedAt - 3 * 60000, cfg, {})
  assert.notEqual(r.phase, 'asleep')
})

check('04:00 还在睡，且已经睡了三小时以上', () => {
  const r = resolve(at(20, 4, 0), cfg, {})
  assert.equal(r.phase, 'asleep')
  assert.ok(r.sleptMinutes >= 180, `只算成 ${r.sleptMinutes} 分钟`)
})

check('刚起床那段是「刚醒」', () => {
  const night = nightForDay(at(20, 12, 0), cfg)
  const r = resolve(night.wakeAt + 10 * 60000, cfg, {})
  assert.equal(r.phase, 'waking')
})

check('上午十点醒着，并给出今晚几点睡', () => {
  const r = resolve(at(20, 10, 0), cfg, {})
  assert.equal(r.phase, 'awake')
  assert.ok(r.upcomingBed > at(20, 10, 0))
  assert.ok(r.upcomingWake > r.upcomingBed)
})

check('晚上离睡不到一小时 → 犯困', () => {
  const night = nightForDay(at(21, 12, 0), cfg) // 21 号凌晨那一夜
  const before = night.bedAt - 20 * 60000
  const r = resolve(before, cfg, {})
  assert.equal(r.phase, 'drowsy', `拿到的是 ${r.phase}`)
})

check('手动"我去睡了"能盖住默认计划', () => {
  const now = at(20, 21, 0)
  const r = resolve(now, cfg, { override: { kind: 'sleep', since: now, until: now + 8 * 3600 * 1000 } })
  assert.equal(r.phase, 'asleep')
  assert.ok(r.sleptMinutes < 5)
})

check('手动覆盖过期后自动失效', () => {
  const r = resolve(at(20, 22, 0), cfg, { override: { kind: 'sleep', since: at(20, 10, 0), until: at(20, 11, 0) } })
  assert.notEqual(r.phase, 'asleep')
})

check('跨午夜的配置（22:30 睡）也算得对', () => {
  const late = normalizeConfig({ bedtime: '22:30', wakeTime: '07:10', jitterMinutes: 0, weekendShiftMinutes: 0 })
  const n = nightForDay(at(20, 12, 0), late)
  assert.ok(n.wakeAt > n.bedAt)
  assert.ok(n.sleptMinutes > 480, `睡了 ${n.sleptMinutes}`)
  const r = resolve(at(21, 3, 0), late, {})
  assert.equal(r.phase, 'asleep')
})

check('注入文本：睡着时说自己在睡，醒着时给今晚时间', () => {
  const asleep = contextText(resolve(at(20, 2, 10), cfg, {}), cfg)
  assert.match(asleep, /睡觉/)
  const awake = contextText(resolve(at(20, 10, 0), cfg, {}), cfg)
  assert.match(awake, /醒着/)
  assert.ok(awake.length < 400, `注入太长：${awake.length} 字`)
  assert.ok(asleep.length < 400, `注入太长：${asleep.length} 字`)
})

check('注入文本在同一相位内是稳定的（缓存能命中）', () => {
  const a = contextText(resolve(at(20, 2, 1), cfg, {}), cfg)
  const b = contextText(resolve(at(20, 2, 4), cfg, {}), cfg)
  assert.equal(a, b)
})

check('同相位跨半小时字节不变（睡着时也不写"已经睡了多久"的分钟数）', () => {
  const a = contextText(resolve(at(20, 3, 0), cfg, {}), cfg)
  const b = contextText(resolve(at(20, 3, 40), cfg, {}), cfg)
  assert.equal(a, b)
})

check('醒着的下午两小时内字节不变', () => {
  const a = contextText(resolve(at(20, 14, 0), cfg, {}), cfg)
  const b = contextText(resolve(at(20, 16, 30), cfg, {}), cfg)
  assert.equal(a, b)
})

check('注入文本里没有钟点式倒计时（"现在 12:40 / 还有 X 小时"）', () => {
  const text = contextText(resolve(at(20, 14, 0), cfg, {}), cfg)
  assert.ok(!/还有/.test(text), '还在写"还有多少"——那就每 15 分钟变一次')
  assert.ok(!/现在是\s*\d{1,2}:\d{2}/.test(text), '还在写当前钟点——那就每 10 分钟变一次')
})

check('periodOf 分段与 sleptWord 粗档', () => {
  assert.equal(periodOf(at(20, 2, 0)), '凌晨')
  assert.equal(periodOf(at(20, 7, 0)), '早上')
  assert.equal(periodOf(at(20, 15, 0)), '下午')
  assert.equal(periodOf(at(20, 23, 0)), '夜里')
  assert.equal(sleptWord(3), '刚躺下')
  assert.equal(sleptWord(60), '睡了一会儿')
  assert.equal(sleptWord(200), '睡了几个钟头')
  assert.equal(sleptWord(400), '睡了挺久')
})

check('状态行给得出来', () => {
  assert.ok(statusLine(resolve(at(20, 15, 0), cfg, {}), cfg).length > 5)
})

check('睡眠债：连着几天睡不够会累加', () => {
  const history = [
    { key: '2026-11-17', sleptMinutes: 300 },
    { key: '2026-11-18', sleptMinutes: 330 },
    { key: '2026-11-19', sleptMinutes: 360 },
  ]
  const r = resolve(at(20, 15, 0), cfg, { history })
  assert.ok(r.debtMinutes >= 200, `只算成 ${r.debtMinutes}`)
})

check('dateKey / clock 是本地时间', () => {
  assert.equal(dateKey(at(20, 0, 5)), '2026-11-20')
  assert.equal(clock(at(20, 22, 7)), '22:07')
})

for (const [mark, name] of results) console.log(`${mark} ${name}`)
const bad = results.filter(([m]) => m === '✗').length
console.log(`\n${results.length - bad}/${results.length} 通过`)
