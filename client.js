/**
 * dsh-circadian —— 界面侧（一条作息）
 * ============================================================================
 * 挂在会话输入框下沿（conversation.composer.dock），一条细的：
 *   睡着 Zzz · 已睡 1 小时 15 分 · 07:38 会醒
 * 点开是一张卡片：今晚几点睡几点起、午睡、睡眠债、24 小时条，和三个按钮
 * （去睡 / 叫她起来 / 按回计划）。数据全部来自宿主 /api/circadian。
 *
 * client bundle 是自注册脚本，不是 ESM —— 别改成 import/export。
 * 样式只用 --dsw-alias-* 主题 token，颜色不写死（深浅色自动跟）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-circadian',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/circadian'

    const CSS = `
.circ-wrap{font-family:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);user-select:none}
.circ-row{display:flex;align-items:center;gap:8px;padding:2px 6px;border-radius:8px;cursor:pointer;
  transition:background .15s ease;min-height:22px}
.circ-row:hover{background:var(--dsw-alias-bg-layer-2)}
.circ-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.circ-dot[data-phase="awake"]{background:var(--dsw-alias-state-success-primary)}
.circ-dot[data-phase="drowsy"]{background:var(--dsw-alias-state-warn-primary)}
.circ-dot[data-phase="waking"]{background:var(--dsw-alias-state-warn-primary)}
.circ-dot[data-phase="asleep"]{background:var(--dsw-alias-brand-primary)}
.circ-dot[data-phase="napping"]{background:var(--dsw-alias-brand-primary)}
.circ-label{color:var(--dsw-alias-label-primary);font-weight:600;flex:none}
.circ-sep{opacity:.45;flex:none}
.circ-now{flex:none;font-variant-numeric:tabular-nums;opacity:.75}
.circ-next{flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.circ-short{flex:none;color:var(--dsw-alias-label-primary);opacity:.85;font-variant-numeric:tabular-nums;white-space:nowrap}
.circ-wrap{min-width:0;max-width:100%}
.circ-row{max-width:100%;overflow:hidden}
.circ-bar{flex:1;min-width:60px;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);
  position:relative;overflow:hidden}
.circ-seg{position:absolute;top:0;bottom:0}
.circ-seg[data-kind="sleep"]{background:var(--dsw-alias-brand-primary);opacity:.55}
.circ-seg[data-kind="nap"]{background:var(--dsw-alias-state-success-primary);opacity:.45}
.circ-mark{position:absolute;top:-1px;bottom:-1px;width:1.5px;background:var(--dsw-alias-label-primary);opacity:.85}
.circ-zzz{flex:none;color:var(--dsw-alias-brand-primary);animation:circ-breathe 3.2s ease-in-out infinite}
.circ-open{flex:none;opacity:.5;transition:transform .15s ease}
.circ-row[data-open="1"] .circ-open{transform:rotate(180deg)}
@keyframes circ-breathe{0%,100%{opacity:.45}50%{opacity:1}}
.circ-card{margin:4px 0 6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px}
.circ-head{display:flex;align-items:baseline;gap:8px}
.circ-title{color:var(--dsw-alias-label-primary);font-weight:600}
.circ-spacer{flex:1}
.circ-kv{display:grid;grid-template-columns:56px 1fr;gap:2px 10px}
.circ-k{opacity:.7}
.circ-v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.circ-v em{font-style:normal;color:var(--dsw-alias-state-warn-primary)}
.circ-full{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);position:relative;overflow:hidden}
.circ-ticks{display:flex;justify-content:space-between;font-size:10px;opacity:.5;font-variant-numeric:tabular-nums}
.circ-actions{display:flex;gap:6px;flex-wrap:wrap}
.circ-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.circ-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.circ-btn[disabled]{opacity:.45;cursor:default}
.circ-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
`

    const pad = (n) => String(n).padStart(2, '0')
    const hhmm = (ms) => {
      const d = new Date(ms)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const modMin = (ms) => {
      const d = new Date(ms)
      return d.getHours() * 60 + d.getMinutes()
    }
    const human = (minutes) => {
      const n = Math.max(0, Math.round(Number(minutes) || 0))
      const hh = Math.floor(n / 60)
      const mm = n % 60
      if (hh && mm) return `${hh} 小时 ${mm} 分`
      if (hh) return `${hh} 小时`
      return `${mm} 分钟`
    }
    const PHASE_TEXT = {
      asleep: '睡着',
      waking: '刚醒',
      drowsy: '犯困',
      napping: '午睡',
      awake: '醒着',
    }

    const Moon = () => h('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
      h('path', {
        d: 'M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z',
        fill: 'currentColor', opacity: 0.9,
      }))
    const Sun = () => h('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
      h('circle', { cx: 12, cy: 12, r: 4.2, fill: 'currentColor' }),
      h('path', {
        d: 'M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    const Zzz = () => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, style: { display: 'block' } },
      h('path', { d: 'M4 6h6l-6 7h6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
      h('path', { d: 'M14 13h5l-5 6h5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round', opacity: 0.7 }))
    const Caret = () => h('svg', { viewBox: '0 0 24 24', width: 12, height: 12, 'aria-hidden': true, style: { display: 'block' } },
      h('path', { d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))

    /** 把某一天 00:00–24:00 里的一段映射成 0..1 的位置（跨午夜就拆成两段） */
    function spans(fromMs, toMs) {
      const a = modMin(fromMs)
      const b = modMin(toMs)
      if (b > a) return [[a / 1440, (b - a) / 1440]]
      return [[a / 1440, (1440 - a) / 1440], [0, b / 1440]]
    }

    function Bar(props) {
      const data = props.data || {}
      const nowMin = modMin(props.now)
      const segs = []
      if (data.night) {
        spans(data.night.bedAt, data.night.wakeAt).forEach(([left, width], i) => {
          segs.push(h('div', { key: 's' + i, className: 'circ-seg', 'data-kind': 'sleep', style: { left: `${left * 100}%`, width: `${width * 100}%` } }))
        })
      }
      if (data.todaysNap) {
        spans(data.todaysNap.start, data.todaysNap.end).forEach(([left, width], i) => {
          segs.push(h('div', { key: 'n' + i, className: 'circ-seg', 'data-kind': 'nap', style: { left: `${left * 100}%`, width: `${width * 100}%` } }))
        })
      }
      segs.push(h('div', { key: 'now', className: 'circ-mark', style: { left: `${(nowMin / 1440) * 100}%` } }))
      return h('div', { className: props.full ? 'circ-full' : 'circ-bar', title: '一天：深色是睡觉，浅绿是午睡，竖线是现在' }, segs)
    }

    function Widget() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [tick, setTick] = React.useState(0)

      const load = React.useCallback(() => {
        fetch(API, { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => { if (j && j.ok) { setData(j); setErr('') } else setErr((j && j.error) || '读不到作息') })
          .catch((e) => setErr(String((e && e.message) || e)))
      }, [])

      React.useEffect(() => {
        load()
        const a = setInterval(load, 30000)
        const b = setInterval(() => setTick((x) => x + 1), 10000)
        return () => { clearInterval(a); clearInterval(b) }
      }, [load])

      const act = (action) => {
        setBusy(action)
        fetch(API, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
          .then((r) => r.json())
          .then((j) => { if (j && j.ok) setData(j) })
          .catch(() => { /* 失败就保持原样，下一轮刷新会纠正 */ })
          .finally(() => setBusy(''))
      }

      if (err && !data) {
        return h('div', { className: 'circ-wrap' }, h('div', { className: 'circ-row' },
          h('span', { className: 'circ-dot' }),
          h('span', { className: 'circ-next' }, `作息没接通：${err}`)))
      }
      if (!data) return h('div', { className: 'circ-wrap' })

      const phase = data.phase || 'awake'
      const now = Date.now()
      const asleep = phase === 'asleep' || phase === 'napping'
      const nextAt = data.next ? data.next.at : 0
      // 输入框底下这一行跟用量统计挤在一起，地方很窄：只放最短的那句，细节留在点开的卡片里
      const shortText = !data.next
        ? ''
        : phase === 'waking'
          ? '缓一会儿'
          : data.next.kind === 'wake'
            ? `${hhmm(nextAt)} 醒`
            : `${hhmm(nextAt)} 睡`
      const icon = asleep ? h(Zzz) : phase === 'drowsy' || phase === 'waking' ? h(Moon) : h(Sun)

      const row = h('div', {
        className: 'circ-row',
        'data-open': open ? '1' : '0',
        onClick: () => setOpen(!open),
        title: open ? '收起来' : String(data.line || '看她的作息'),
      },
        h('span', { className: 'circ-dot', 'data-phase': phase }),
        h('span', { className: asleep ? 'circ-zzz' : 'circ-label', style: { display: 'inline-flex', alignItems: 'center' } }, icon),
        h('span', { className: 'circ-label' }, PHASE_TEXT[phase] || phase),
        shortText ? h('span', { className: 'circ-sep' }, '·') : null,
        shortText ? h('span', { className: 'circ-short' }, shortText) : null,
        h(Bar, { data, now }),
        h('span', { className: 'circ-open' }, h(Caret)))

      if (!open) return h('div', { className: 'circ-wrap' }, row)

      const title = (data.config && data.config.title) || '作息'
      const night = data.night || {}
      const nap = data.todaysNap
      const debt = Number(data.debtMinutes) || 0

      return h('div', { className: 'circ-wrap' },
        row,
        h('div', { className: 'circ-card' },
          h('div', { className: 'circ-head' },
            h('span', { className: 'circ-title' }, title),
            h('span', { className: 'circ-spacer' }),
            h('span', { className: 'circ-now' }, `现在 ${hhmm(now)}`)),
          h('div', { className: 'circ-kv' },
            h('span', { className: 'circ-k' }, '这一夜'),
            h('span', { className: 'circ-v' }, night.bedAt
              ? `${hhmm(night.bedAt)} 睡 → ${hhmm(night.wakeAt)} 起 · ${human(night.sleptMinutes)}`
              : '还没算出来'),
            h('span', { className: 'circ-k' }, '午睡'),
            h('span', { className: 'circ-v' }, !data.config.napEnabled
              ? '不睡'
              : nap ? `${hhmm(nap.start)}–${hhmm(nap.end)}` : '今天不睡'),
            h('span', { className: 'circ-k' }, '睡眠债'),
            h('span', { className: 'circ-v' }, debt >= 30
              ? h('em', null, `欠了 ${human(debt)}（近七晚）`)
              : '不欠'),
            h('span', { className: 'circ-k' }, '被吵醒'),
            h('span', { className: 'circ-v' }, data.wokeCount ? `${data.wokeCount} 次` : '一次没被叫')),
          h(Bar, { data, now, full: true }),
          h('div', { className: 'circ-ticks' }, h('span', null, '00'), h('span', null, '06'), h('span', null, '12'), h('span', null, '18'), h('span', null, '24')),
          h('div', { className: 'circ-actions' },
            h('button', {
              className: 'circ-btn',
              'data-primary': asleep ? '0' : '1',
              disabled: Boolean(busy) || phase === 'asleep',
              onClick: () => act('sleep'),
            }, busy === 'sleep' ? '……' : '让她去睡'),
            h('button', {
              className: 'circ-btn',
              disabled: Boolean(busy) || (!asleep && phase !== 'waking'),
              onClick: () => act('wake'),
            }, busy === 'wake' ? '……' : '叫她起来'),
            h('button', {
              className: 'circ-btn',
              disabled: Boolean(busy) || !data.override,
              onClick: () => act('clear'),
            }, busy === 'clear' ? '……' : '按回计划'),
            h('span', { className: 'circ-spacer' }),
            debt >= 30 ? h('span', { className: 'circ-now' }, `目标 ${data.config.targetSleepHours} 小时/晚`) : null),
        ))
    }


    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-circadian')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'circadian: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'circadian',
          order: 20,
          label: () => '作息',
        }, Widget)), 'circadian: 输入框下沿的作息条')
      },
    }
  },
})
