# 关机（dsh-shutdown-scheduler）

给 DeepSeek Harness 的 **设置面板** 加一个「关机」页。入口就是左下角侧边栏底部的设置按钮：
打开设置后，左侧导航里会出现「关机」。

## 功能

| 功能 | 行为 |
| --- | --- |
| **定时关机** | 选一个时刻（HH:MM）。到点后立即下达关机命令，**再经过 3 分钟延时**才真正关机。 |
| **延时关机** | 快捷按钮 +30 分钟 / +1 小时 / +2 小时；到点后同样下达命令，再经过 3 分钟延时。 |
| **立即关机** | 马上开始 3 分钟倒计时。 |
| **任务结束后关机** | 开启后，当下一个任务运行结束、且没有其他任务在运行时，自动下达关机命令。 |
| **取消关机** | 3 分钟倒计时期间随时可取消；定时未到点时可「取消定时」。 |

**时间到后自动执行关机，不会再弹任何确认框。**

## 3 分钟延时是怎么实现的

倒计时不是插件自己数的，而是交给操作系统：

- Windows：`shutdown /s /t 180 /c "…"`，取消用 `shutdown /a`
- Linux / macOS：`shutdown -h +3`，取消用 `shutdown -c`

好处是即使 DSH 进程在倒计时期间退出或崩溃，系统仍然会按时关机；取消也仍然有效。
设置页底部会显示当前平台真实执行的命令，方便核对。

## 任务结束后关机的细节

- 必须**先有一个任务真正跑起来并结束**才会触发。刚打开开关时如果没有任何任务在跑，不会立刻关机，
  界面会显示「已开启，尚未检测到运行中的任务」。
- 倒计时期间如果又来了新任务，会**自动取消**这次关机（避免打断正在跑的任务）；等新任务结束后会重新计时。
- 其他会话 / 子代理还在运行时不会触发，等全部空闲后才会。

## 安全演练

设置页有一个「安全演练」开关：打开后只记录将要执行的命令，**不会真的关机**。
第一次配置定时关机时建议先打开它验证一遍。

## 配置

配置文件在 bundle 自带的 `cordis.patch.yml`，安装后也可以直接改 profile 的
`cordis.patch.yml`（需要重启生效）：

```yaml
- insert:
    - id: dsh-shutdown-scheduler
      name: dsh-shutdown-scheduler
      config:
        graceSeconds: 180      # 延时秒数，默认 180
        dryRun: false          # 默认是否演练模式
        startBinary: ''        # 关机命令的可执行文件，留空用平台默认 shutdown
        cancelBinary: ''       # 取消命令的可执行文件，留空用平台默认 shutdown
        startArgs: null        # 自定义 argv，null 用平台默认
        cancelArgs: null
        comment: 'DeepSeek Harness scheduled shutdown. Run "shutdown /a" to cancel.'
```

## HTTP 接口

设置页通过一条同源、带 CSRF 防护的路由与主机通信，也可以自己调：

```js
fetch('/dsh-shutdown/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'state', payload: null }),
})
```

方法：`state`、`arm`、`schedule`（`{at:'HH:MM'}` 或 `{inSeconds:n}`）、`cancel`、
`setTaskEnd`（`{enabled}`）、`setDryRun`（`{enabled}`）。

跨站请求、非 POST 请求、缺失 Host 头的请求都会被拒绝。

`state` 里除界面用到的字段外，还有几个诊断字段：`runningAgents`（主机当前看到几个在跑的任务）、
`agentTransitions`（插件自加载以来观察到的 running / idle 次数）、`lastAgentEventAt`。
任务结束后关机的整个触发链路就是 `agent/status` 事件，这三个字段用来确认这条链路是通的。

## 生效时机

- **浏览器侧**（设置页本身）：宿主服务按文件 mtime 提供新字节，刷新页面即可生效。
- **主机侧**（命令与状态机）：已安装包换成新的 JavaScript 模块需要**重启 DSH**。
  本插件是现场安装的，安装当时进程里跑的还只是旧的一代；DSH 重启后已加载磁盘上的最终版本，
  `runningAgents` / `agentTransitions` / `lastAgentEventAt` 现在可以读到。

## 验证状态

| 项目 | 结果 |
| --- | --- |
| `index.js` / `client.js` 语法与括号平衡 | 通过（`node --check` + 括号扫描） |
| 主机侧行为（26 项，独立测试脚本） | 全部通过 |
| 其中：真实子进程执行 + 真实取消失败上报 | 通过（用 `node -e process.exit(N)` 替身，未触发真实关机） |
| 浏览器侧渲染（10 种主机状态，mini-React 冒烟脚本） | 全部通过，两个语言字典各 49 个键完全对齐 |
| 运行中的 Harness 里实时注册 `settings.section` | 通过（`id=shutdown`、`order=90`、`active=true`） |
| 运行中的 Harness 里真实 HTTP 往返 | 通过（`arm` → 3:00 倒计时 → `cancel` → 空闲；`schedule(4s)` → 到点自动转为倒计时） |
| 主机侧新模块重启后加载 | 通过（`runningAgents`、`agentTransitions` 已可读到） |
| `agent/status` 在真实主机里收到事件 | 通过（重启后实测 `agentTransitions.running` 随真实任务启动递增） |
| 端到端真实关机 | 通过（用户实测：命令下达后系统按时关机，重启后插件随 profile 自动恢复） |
| 重启后的状态卫生 | 通过（`phase=idle`、`taskEndEnabled=false`、`dryRun=false`，无遗留倒计时；`settings.section` 仍为 `active=true`） |

一次真实关机的完整链条已经走过：`shutdown /s /t 180` 下达 → 延时结束系统关机 → 重启后插件随
profile 自动加载，状态归零，没有遗留倒计时，也不会出现「一开机又自己关机」。

唯一没有在无人值守条件下验证的，是「3 分钟窗口内用界面按钮取消真实关机」——取消命令本身
（`shutdown /a`）的成功与失败分支都有测试覆盖，但真实倒计时里的那次点击没有单独记录。

## 其余文件

- `index.js` — 主机侧：命令、状态机、路由、`agent/status` 监听
- `client.js` — 浏览器侧：`settings.section` 里的关机页
- `cordis.patch.yml` — 插入的插件行与默认配置
- `locale/zh.json`、`locale/en.json` — 插件管理器里的标题与描述

测试脚本不在包内，放在工作区的 `../_scratch/`：
`host-behaviour.mjs`（主机侧 26 项）、`render-smoke.mjs`（浏览器侧渲染）、`balance.mjs`（括号平衡）。

## 平台

Windows 是主要目标平台并已按 `/s /t /c` 与 `/a` 实现。Linux / macOS 用 `shutdown` 的
POSIX 形式做尽力而为的处理；如果目标系统上需要 root 或 systemd 变体，请用
`startBinary` / `startArgs` / `cancelBinary` / `cancelArgs` 覆盖。
