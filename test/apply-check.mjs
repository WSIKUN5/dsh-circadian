/**
 * test/apply-check.mjs —— 宿主半的接线自检（不需要 DSH，直接 node 跑）
 *   node test/apply-check.mjs
 *
 * 拿一个假的 ctx 把 apply() 跑一遍，确认：
 *   · 每个 agent 都挂上了 name=circadian 的 systemPrompt context，且 text() 有内容
 *   · 工具注册出来的形状是对的，execute('status') 能回话
 *   · /api/circadian 真的能返回 JSON，POST sleep 之后 phase 变成 asleep
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 干净的家目录：别把测试的 override 写进真的 state/
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'circadian-test-'))
const { apply } = await import('../index.js')

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['✓', name]) }
  catch (e) { results.push(['✗', name + ' — ' + (e && e.message ? e.message : e)]); process.exitCode = 1 }
}

const contexts = []
const tools = []
const routes = []

const fakeAgent = (id) => ({
  id,
  ctx: {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    systemPrompt: {
      context: (c) => { contexts.push({ id, ...c }); return () => {} },
    },
    tools: { register: () => () => {} },
  },
})

let agents = [fakeAgent('s1')]

const ctx = {
  logger: { info: () => {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
  get agents() {
    return { list: () => agents }
  },
  tools: { register: (def) => { tools.push(def); return () => {} } },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
}

apply(ctx, { bedtime: '00:40', wakeTime: '07:30', injectContext: true, exposeTool: true })

check('给已有的 agent 挂上了 systemPrompt context', () => {
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'circadian')
  assert.ok(Number.isFinite(contexts[0].order))
  const text = contexts[0].text({})
  assert.match(text, /\[作息\]/)
  assert.match(text, /别解释作息机制/)
})

check('工具注册出来了，形状对', () => {
  assert.equal(tools.length, 1)
  const t = tools[0]
  assert.equal(t.name, 'circadian')
  assert.equal(typeof t.description, 'string')
  assert.equal(t.parameters.type, 'object')
  assert.equal(t.parameters.additionalProperties, false)
  assert.deepEqual(t.parameters.required, [])
  assert.ok(t.parameters.properties.action.enum.includes('sleep'))
  assert.equal(typeof t.output.render, 'function')
  assert.equal(typeof t.execute, 'function')
})

check('/api/circadian 挂上了 prefix 路由', () => {
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/circadian')
})

// 假 req/res
const call = async (route, method, url, body) => {
  let out = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk) out += chunk },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
  }
  const handlers = {}
  const req = {
    method,
    url,
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn) },
    destroy: () => {},
  }
  const p = route.handler(req, res)
  if (body !== undefined) {
    for (const fn of handlers.data || []) fn(JSON.stringify(body))
  }
  for (const fn of handlers.end || []) fn()
  await p
  await new Promise((r) => setTimeout(r, 20))
  return { status: res.statusCode || 200, json: out ? JSON.parse(out) : null }
}

let lastText = ''
const run = async () => {
  const route = routes[0]

  const g = await call(route, 'GET', '/api/circadian')
  check('GET 回 200 且字段齐', () => {
    assert.equal(g.status, 200)
    assert.equal(g.json.ok, true)
    for (const k of ['phase', 'label', 'clock', 'night', 'agentsWired', 'injectedSample']) {
      assert.ok(k in g.json, `缺字段 ${k}`)
    }
    assert.equal(g.json.agentsWired, 1)
    lastText = g.json.injectedSample
    assert.match(lastText, /\[作息\]/)
  })

  await call(route, 'POST', '/api/circadian', { action: 'clear' })
  const base = await call(route, 'GET', '/api/circadian')
  lastText = base.json.injectedSample

  const s = await call(route, 'POST', '/api/circadian', { action: 'sleep' })
  check('POST sleep 后真的变成睡着', () => {
    assert.equal(s.status, 200)
    assert.equal(s.json.phase, 'asleep')
    assert.equal(s.json.override.kind, 'sleep')
    assert.match(s.json.injectedSample, /你在睡觉/)
    assert.match(s.json.injectedSample, /刚躺下|已经睡了/)
  })

  check('注进去的文字跟着状态变（不是死文本）', () => {
    assert.notEqual(s.json.injectedSample, lastText)
  })

  const c = await call(route, 'POST', '/api/circadian', { action: 'clear' })
  check('POST clear 后回到计划', () => {
    assert.equal(c.json.override, null)
    assert.notEqual(c.json.phase, 'asleep')
  })

  const t = await tools[0].execute({ action: 'status' }, {})
  check('工具 execute(status) 能回话', () => {
    assert.equal(t.ok, true)
    assert.ok(typeof t.line === 'string' && t.line.length > 5)
  })

  const ts = await tools[0].execute({ action: 'sleep' }, {})
  check('工具 execute(sleep) 真的改了状态', () => {
    assert.equal(ts.ok, true)
    assert.equal(ts.phase, 'asleep')
  })
  await tools[0].execute({ action: 'clear' }, {})

  for (const [mark, name] of results) console.log(`${mark} ${name}`)
  const bad = results.filter(([m]) => m === '✗').length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
}

run().catch((e) => { console.error(e); process.exit(1) })
