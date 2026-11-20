# QQ / IM 桥接集成

这里放的是「每条消息前会拼人格卡」的桥接用的那一行字（约 60 字）：

```
【你现在的作息】现在 12:54，你醒着，昨晚睡了 6 小时 56 分，13:06 前后会眯一会儿。今晚大概 00:42 睡。
```

## 原理

`circadian-brief.mjs` 不复制任何逻辑，只是读本插件：

| 读到的东西 | 从哪来 |
|---|---|
| 引擎（相位、抖动、睡眠债） | `<plugin>/lib/schedule.js`（`import` 同一份） |
| 配置（几点睡、午睡、周末偏移） | `<plugin>/cordis.patch.yml` |
| 状态（手动「我去睡了」、近七晚） | `$DSH_HOME/state/dsh-circadian.json` |

所以**桌面里点一下「让她去睡」，QQ 那边下一句回话也是迷糊的**，不需要两边各配一套。

## 接法

在桥接里找到「拼人格卡」的那一处（形如 `const roleHint = currentRoleHint()`），在**截断之后**追加：

```js
import { circadianBrief } from './circadian-brief.mjs'

function withCircadianBrief(text) {
  try {
    if (cfg.circadian && cfg.circadian.enabled === false) return text   // 想要开关
    const brief = circadianBrief()
    return brief ? `${text}\n\n${brief}` : text
  } catch { return text }
}

// 例：roleHintForMode()
return withCircadianBrief(base)
```

追加在截断之后，就不占人格卡的字符预算；拿不到插件时 `circadianBrief()` 返回空串，桥接照常跑。

## 路径

默认按 `$DSH_HOME/plugin-src/dsh-circadian` 找插件。装在别处就设环境变量：

```powershell
$env:CIRCADIAN_PLUGIN_DIR = 'C:\plugins\dsh-circadian'
```

⚠️ 状态文件跟着 `DSH_HOME` 走。一台机器上跑好几只 agent 的时候，桥接进程的 `DSH_HOME`
必须指着**它服务的那一只**，否则读到的是别人的作息。

## 自检

```bash
node -e "import('./circadian-brief.mjs').then(m=>{await new Promise(r=>setTimeout(r,200));console.log(m.circadianDebug())})"
```

`engine: 'ready'` 且 `brief` 有内容就算接上了；`engine: 'failed'` 说明路径不对。