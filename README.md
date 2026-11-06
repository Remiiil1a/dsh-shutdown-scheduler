# 关机（dsh-shutdown-scheduler）

给 DeepSeek Harness 加一个「关机」页，有**两个入口**，渲染的是同一套控件、同一份主机状态：

- **侧边栏快捷入口**：左侧栏「插件 / 插件市场 / 自动化任务」那一组里多一行「关机」（电源图标）。
  点一下就在中栏打开完整关机页，倒计时期间不用再翻设置。侧边栏收起成 56px 图标栏时只显示图标。
- **设置面板**：左下角设置按钮 → 左侧导航里也有「关机」。

## 侧边栏入口是怎么来的

DSH 的侧边栏全局面板行由 `sidebar.panellist` 这个 list slot 提供，每行用 `id` 指向 `main`
keyed slot 里同名的面板；两个注册都用同一个 id（`shutdown`）绑在一起，缺一个点上去就会抛错。
本插件因此注册了三处：

| 注册 | 作用 |
| --- | --- |
| `sidebar.panellist`（id `shutdown`、order 20） | 红色方框那一组里的一行「关机」 |
| `main`（key `shutdown`） | 这一行打开的中栏页面，自带标题、说明与滚动容器 |
| `settings.section`（id `shutdown`、order 90） | 设置面板里的关机页（原有入口，保留） |

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
页面底部会显示当前平台真实执行的命令，方便核对。

## 任务结束后关机的细节

- 必须**先有一个任务真正跑起来并结束**才会触发。刚打开开关时如果没有任何任务在跑，不会立刻关机，
  界面会显示「已开启，尚未检测到运行中的任务」。
- 倒计时期间如果又来了新任务，会**自动取消**这次关机（避免打断正在跑的任务）；等新任务结束后会重新计时。
- 其他会话 / 子代理还在运行时不会触发，等全部空闲后才会。

## 安全演练

两个入口里都有「安全演练」开关：打开后只记录将要执行的命令，**不会真的关机**。
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

两个入口都通过一条同源、带 CSRF 防护的路由与主机通信，也可以自己调：

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

本插件是 profile 里的 git 依赖（`github:Remiiil1a/dsh-shutdown-scheduler`），运行时读的是
`profiles/<name>/node_modules/` 下的那份**拷贝**，不是源码工作区。所以：

- **装上新版本**：升级这个依赖（重新按该仓库安装一次），`node_modules` 里的拷贝才会更新。
- **浏览器侧**（侧边栏行 + 两个页面）：客户端模块由宿主按文件内容提供，装好后**刷新页面**即可看到新行。
- **主机侧**（命令与状态机，本次未改）：`index.js` 的改动需要**重启 DSH** 才换到新模块。

## 验证状态

| 项目 | 结果 |
| --- | --- |
| `index.js` / `client.js` 语法与括号平衡 | 通过（`node --check` + 括号扫描） |
| 主机侧行为（26 项，独立测试脚本） | 全部通过（本次改动未触及主机侧，回归仍全绿） |
| 其中：真实子进程执行 + 真实取消失败上报 | 通过（用 `node -e process.exit(N)` 替身，未触发真实关机） |
| 浏览器侧渲染：设置页（11 种主机状态，mini-React 冒烟脚本） | 全部通过 |
| 浏览器侧渲染：侧边栏快捷页（4 种状态 + 标题/说明） | 全部通过 |
| 侧边栏行图标（16 / 18px 两个尺寸） | 通过（svg 尺寸跟随入参，两段路径） |
| 两个语言字典 | 各 50 个键完全对齐 |
| 三处注册的 id / key 绑定 | 通过（`sidebar.panellist.id` = `main.key` = `shutdown`、order 20、label「关机」） |
| 运行中的 Harness 里实时注册 `settings.section` | 通过（`id=shutdown`、`order=90`、`active=true`；加行前的旧版本） |
| 运行中的 Harness 里出现新的「关机」侧边栏行 | **待装新版本后人工确认**（见「生效时机」；本次只改工作区，未动已安装拷贝） |
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
- `client.js` — 浏览器侧：`sidebar.panellist` 行 + `main` 快捷页 + `settings.section` 页，三者共用同一套控件
- `cordis.patch.yml` — 插入的插件行与默认配置
- `locale/zh.json`、`locale/en.json` — 插件管理器里的标题与描述

测试脚本不在包内，放在工作区的 `../_scratch/`：
`host-behaviour.mjs`（主机侧 26 项）、`render-smoke.mjs`（三处注册的浏览器侧渲染）、`balance.mjs`（括号平衡）。

## 平台

Windows 是主要目标平台并已按 `/s /t /c` 与 `/a` 实现。Linux / macOS 用 `shutdown` 的
POSIX 形式做尽力而为的处理；如果目标系统上需要 root 或 systemd 变体，请用
`startBinary` / `startArgs` / `cancelBinary` / `cancelArgs` 覆盖。
