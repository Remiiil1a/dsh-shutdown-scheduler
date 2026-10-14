/**
 * Client half of `dsh-shutdown-scheduler`.
 *
 * Registers one page in the Settings panel — the seat reached from the
 * settings button at the bottom-left of the sidebar — and renders the
 * shutdown controls: the live countdown with its cancel button, an immediate
 * (delayed) shutdown, a wall-clock schedule, the shutdown-after-task-end
 * switch, and a simulation switch.
 *
 * The host half owns every command; this file only renders its state and
 * posts one JSON envelope to `/dsh-shutdown/api`.
 */

window.__ModuleLoader__.load({
	id: 'dsh-shutdown-scheduler',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** The host half's single route. */
		const API = '/dsh-shutdown/api'
		/** Locale namespace owned by this plugin. */
		const NS = 'dsh-shutdown-scheduler'
		/** Settings section key. */
		const SECTION_ID = 'shutdown'

		const ZH = {
			nav: '关机',
			loading: '正在读取关机状态…',
			unreachable: '无法连接 Harness 主机：{message}',
			retry: '重试',
			statusIdle: '当前没有计划中的关机。',
			statusTitle: '关机状态',
			statusScheduledClock: '已计划：{time}（{when}）',
			statusScheduledDelay: '已计划：{when}',
			statusCountdown: '关机倒计时',
			countdownHint: '时间到后自动执行关机，无需确认。',
			whenIn: '{duration}后',
			whenToday: '今天',
			whenTomorrow: '明天',
			sourceManual: '手动触发',
			sourceSchedule: '定时触发',
			sourceTaskEnd: '任务结束触发',
			lastEventArmed: '关机命令已下达',
			lastEventScheduled: '定时关机已设定',
			lastEventCancelled: '已取消关机',
			lastEventRescheduled: '已重新设定定时关机',
			lastEventExecuted: '延时结束，已执行关机',
			lastEventExecutedDry: '延时结束（演练，未真正关机）',
			lastEventArmFailed: '关机命令执行失败',
			lastEventCancelFailed: '取消失败，系统仍在倒计时',
			lastEventTaskStarted: '检测到新任务，已取消任务结束关机',
			cancel: '取消关机',
			cancelSchedule: '取消定时',
			armTitle: '立即关机',
			armDesc: '立即下达关机命令，{grace}后自动执行，期间可随时取消。',
			armButton: '开始倒计时',
			delayTitle: '延时关机',
			delayDesc: '设定一个相对时间，到点后下达关机命令，再经过{grace}的延时自动执行。',
			delay30: '+30 分钟',
			delay60: '+1 小时',
			delay120: '+2 小时',
			scheduleTitle: '定时关机',
			scheduleDesc: '到达设定时间后下达关机命令，再经过{grace}的延时自动执行。',
			scheduleButton: '设定定时',
			taskEndTitle: '任务结束后关机',
			taskEndDesc: '开启后，当下一个任务运行结束、且没有其他任务在运行时，自动下达关机命令。',
			taskEndWaiting: '已开启，等待任务结束…',
			taskEndRunning: '已开启，当前有 {count} 个任务运行中，等它们结束后关机。',
			taskEndIdle: '已开启，尚未检测到运行中的任务；下一个任务结束时会自动关机。',
			dryRunTitle: '安全演练',
			dryRunDesc: '开启后只记录将要执行的命令，不会真正关机。',
			commandTitle: '当前平台命令',
			commandCancel: '取消命令',
			lastError: '最后一次错误：{message}',
			busy: '处理中…',
		}

		const EN = {
			nav: 'Shutdown',
			loading: 'Reading shutdown status…',
			unreachable: 'Cannot reach the Harness host: {message}',
			retry: 'Retry',
			statusIdle: 'No shutdown is scheduled.',
			statusTitle: 'Shutdown status',
			statusScheduledClock: 'Scheduled for {time} ({when})',
			statusScheduledDelay: 'Scheduled: {when}',
			statusCountdown: 'Shutdown countdown',
			countdownHint: 'The machine powers off automatically when the countdown ends; nothing else is asked.',
			whenIn: 'in {duration}',
			whenToday: 'today',
			whenTomorrow: 'tomorrow',
			sourceManual: 'started by hand',
			sourceSchedule: 'scheduled time reached',
			sourceTaskEnd: 'task finished',
			lastEventArmed: 'Shutdown command issued',
			lastEventScheduled: 'Scheduled shutdown set',
			lastEventCancelled: 'Shutdown cancelled',
			lastEventRescheduled: 'Scheduled shutdown replaced',
			lastEventExecuted: 'Grace window elapsed; shutdown executed',
			lastEventExecutedDry: 'Grace window elapsed (simulated)',
			lastEventArmFailed: 'The shutdown command failed',
			lastEventCancelFailed: 'Cancel failed — the system is still counting down',
			lastEventTaskStarted: 'A new task started; task-end shutdown was cancelled',
			cancel: 'Cancel shutdown',
			cancelSchedule: 'Cancel schedule',
			armTitle: 'Shut down now',
			armDesc: 'Issues the shutdown command at once; it runs after {grace} unless cancelled.',
			armButton: 'Start countdown',
			delayTitle: 'Delay shutdown',
			delayDesc: 'Pick a relative delay; at that point the command is issued and then runs after {grace}.',
			delay30: '+30 minutes',
			delay60: '+1 hour',
			delay120: '+2 hours',
			scheduleTitle: 'Scheduled shutdown',
			scheduleDesc: 'At the chosen time the shutdown command is issued, then runs after {grace}.',
			scheduleButton: 'Set schedule',
			taskEndTitle: 'Shut down when the task ends',
			taskEndDesc: 'When on, the shutdown command is issued once the next task finishes and no other task is running.',
			taskEndWaiting: 'On — waiting for a task to finish…',
			taskEndRunning: 'On — {count} task(s) running; the shutdown starts when they finish.',
			taskEndIdle: 'On — no running task seen yet; the next finished task starts the shutdown.',
			dryRunTitle: 'Simulation',
			dryRunDesc: 'When on, commands are only recorded; the machine is never shut down.',
			commandTitle: 'Command on this platform',
			commandCancel: 'Cancel command',
			lastError: 'Last error: {message}',
			busy: 'Working…',
		}

		const CSS = [
			'.dshsd-root{display:flex;flex-direction:column;width:100%}',
			'.dshsd-row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
			'.dshsd-row:last-child{border-bottom:none}',
			'.dshsd-col{flex:1;min-width:0}',
			'.dshsd-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
			'.dshsd-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
			'.dshsd-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}',
			'.dshsd-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer}',
			'.dshsd-btn:hover:enabled{background:var(--dsw-alias-bg-layer-1)}',
			'.dshsd-btn:disabled{opacity:.5;cursor:default}',
			'.dshsd-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:600}',
			'.dshsd-time{height:28px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px}',
			'.dshsd-switch{position:relative;flex:0 0 auto;width:34px;height:20px;padding:0;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
			'.dshsd-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent}',
			'.dshsd-switch:disabled{opacity:.5;cursor:default}',
			'.dshsd-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease}',
			'.dshsd-switch[aria-checked="true"] .dshsd-knob{transform:translateX(14px);background:var(--dsw-alias-bg-base)}',
			'.dshsd-banner{margin:8px 0 4px;padding:12px 16px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
			'.dshsd-banner-warn{border-color:var(--dsw-alias-state-warn-primary)}',
			'.dshsd-banner-error{border-color:var(--dsw-alias-state-error-primary)}',
			'.dshsd-banner-title{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;letter-spacing:.04em;text-transform:uppercase}',
			'.dshsd-count{margin-top:2px;color:var(--dsw-alias-state-warn-primary);font-size:24px;line-height:32px;font-weight:600;font-variant-numeric:tabular-nums}',
			'.dshsd-count-urgent{color:var(--dsw-alias-state-error-primary)}',
			'.dshsd-banner-body{margin-top:4px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
			'.dshsd-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:2px}',
			'.dshsd-code{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
			'.dshsd-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:2px;overflow-wrap:anywhere}',
		].join('')

		/**
		 * Post one envelope to the host half.
		 * @param method - host method name.
		 * @param payload - JSON payload.
		 * @returns the host's value.
		 */
		async function callHost(method, payload) {
			const response = await fetch(API, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method, payload: payload === undefined ? null : payload }),
			})
			const parsed = await response.json().catch(() => null)
			if (parsed === null || parsed.ok !== true) {
				const message = parsed !== null && parsed.error !== undefined ? parsed.error.message : `HTTP ${response.status}`
				throw new Error(message)
			}
			return parsed.value
		}

		/** Format a millisecond remainder as `m:ss`. */
		function formatCountdown(ms) {
			const total = Math.max(0, Math.ceil(ms / 1000))
			return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
		}

		/** Format a millisecond duration as localized-ish `H小时M分` / `Hh Mm`. */
		function formatDuration(ms, zh) {
			const totalMinutes = Math.max(0, Math.round(ms / 60000))
			const hours = Math.floor(totalMinutes / 60)
			const minutes = totalMinutes % 60
			if (hours === 0) return zh ? `${minutes} 分钟` : `${minutes} min`
			if (minutes === 0) return zh ? `${hours} 小时` : `${hours} h`
			return zh ? `${hours} 小时 ${minutes} 分` : `${hours} h ${minutes} min`
		}

		/** Format the grace window in seconds for descriptions. */
		function formatGrace(seconds, zh) {
			if (seconds % 60 === 0) {
				const minutes = seconds / 60
				return zh ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`
			}
			return zh ? `${seconds} 秒` : `${seconds} second${seconds === 1 ? '' : 's'}`
		}

		/**
		 * Map a `lastEvent` value onto its copy key.
		 * @param event - the host-reported event.
		 * @returns the locale key, or undefined.
		 */
		const EVENT_KEYS = {
			armed: 'lastEventArmed',
			scheduled: 'lastEventScheduled',
			cancelled: 'lastEventCancelled',
			rescheduled: 'lastEventRescheduled',
			'cancel-failed': 'lastEventCancelFailed',
			executed: 'lastEventExecuted',
			'executed-dry-run': 'lastEventExecutedDry',
			'arm-failed': 'lastEventArmFailed',
			'task-started': 'lastEventTaskStarted',
		}

		/** One labelled switch row. */
		function SwitchRow(props) {
			return h('div', { className: 'dshsd-row' }, [
				h('div', { className: 'dshsd-col', key: 'text' }, [
					h('div', { className: 'dshsd-title', key: 'title' }, props.title),
					props.description === undefined
						? null
						: h('div', { className: 'dshsd-desc', key: 'desc' }, props.description),
				]),
				h('button', {
					key: 'switch',
					type: 'button',
					role: 'switch',
					'aria-checked': props.checked ? 'true' : 'false',
					'aria-label': props.title,
					className: 'dshsd-switch',
					disabled: props.disabled === true,
					onClick: () => props.onChange(!props.checked),
				}, h('span', { className: 'dshsd-knob' })),
			])
		}

		/**
		 * Build the settings page component over the plugin's locale binding.
		 * @param ctx - the client plugin context.
		 * @param t - the locale-bound translate function.
		 * @returns the React component registered into `settings.section`.
		 */
		function makeSection(ctx, t) {
			return function ShutdownSection() {
				const [state, setState] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [busy, setBusy] = React.useState(false)
				const [tick, setTick] = React.useState(0)
				const [clock, setClock] = React.useState(() => defaultClock())
				const deadlineRef = React.useRef(0)
				const [localeRevision, setLocaleRevision] = React.useState(0)

				// Text follows the active locale without a remount.
				React.useEffect(() => ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1)), [ctx])

				const applySnapshot = React.useCallback((next) => {
					if (next === null || next === undefined) return
					setState(next)
					deadlineRef.current = next.phase === 'countdown' ? Date.now() + Math.max(0, next.remainingMs) : 0
				}, [])

				const reload = React.useCallback(async () => {
					try {
						applySnapshot(await callHost('state'))
						setError(null)
					} catch (failure) {
						setError(failure instanceof Error ? failure.message : String(failure))
					}
				}, [applySnapshot])

				const send = React.useCallback(async (method, payload) => {
					setBusy(true)
					try {
						applySnapshot(await callHost(method, payload))
						setError(null)
					} catch (failure) {
						setError(failure instanceof Error ? failure.message : String(failure))
						void reload()
					} finally {
						setBusy(false)
					}
				}, [applySnapshot, reload])

				React.useEffect(() => {
					void reload()
					const ticker = window.setInterval(() => setTick((value) => value + 1), 500)
					const poller = window.setInterval(() => { void reload() }, 3000)
					return () => {
						window.clearInterval(ticker)
						window.clearInterval(poller)
					}
				}, [reload])

				const zh = ctx.locale.getLocale().active === 'zh'
				void localeRevision
				void tick

				const children = [
					h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
				]

				if (state === null) {
					children.push(h('div', { className: 'dshsd-row', key: 'loading' }, [
						h('div', { className: 'dshsd-col', key: 'text' }, [
							h('div', { className: 'dshsd-title', key: 'title' }, error === null ? t('loading') : t('unreachable', { message: error })),
							error === null ? null : h('div', { className: 'dshsd-desc', key: 'desc' }, t('retry')),
						]),
						h('div', { className: 'dshsd-actions', key: 'actions' }, [
							h('button', { key: 'retry', type: 'button', className: 'dshsd-btn', onClick: () => { void reload() } }, t('retry')),
						]),
					]))
					return h('div', { className: 'dshsd-root' }, children)
				}

				const counting = state.phase === 'countdown'
				const remaining = counting ? Math.max(0, deadlineRef.current - Date.now()) : 0
				const urgent = counting && remaining <= 60000
				const grace = formatGrace(state.graceSeconds, zh)

				// Status banner.
				let bannerBody
				if (counting) {
					bannerBody = [
						h('div', { className: urgent ? 'dshsd-count dshsd-count-urgent' : 'dshsd-count', key: 'count' }, formatCountdown(remaining)),
						h('div', { className: 'dshsd-banner-body', key: 'hint' }, t('countdownHint')),
						h('div', { className: 'dshsd-muted', key: 'src' }, state.source === 'task-end'
							? t('sourceTaskEnd')
							: state.source === 'schedule' ? t('sourceSchedule') : t('sourceManual')),
					]
				} else if (state.phase === 'scheduled') {
					const when = state.scheduleSource === 'clock'
						? dayLabel(state.scheduledAt, zh)
						: formatDuration(state.scheduledInMs, zh)
					bannerBody = [
						h('div', { className: 'dshsd-banner-body', key: 'body' }, state.scheduleSource === 'clock'
							? t('statusScheduledClock', { time: state.scheduleLabel, when })
							: t('statusScheduledDelay', { when })),
						h('div', { className: 'dshsd-muted', key: 'at' }, t('whenIn', { duration: formatDuration(state.scheduledInMs, zh) })),
					]
				} else {
					bannerBody = [h('div', { className: 'dshsd-banner-body', key: 'body' }, t('statusIdle'))]
				}
				if (state.lastError !== null && state.lastError !== undefined) {
					bannerBody.push(h('div', { className: 'dshsd-error', key: 'error' }, t('lastError', { message: state.lastError })))
				}

				const eventKey = EVENT_KEYS[state.lastEvent]
				const statusRows = [
					h('div', {
						key: 'banner',
						className: counting ? 'dshsd-banner dshsd-banner-warn' : 'dshsd-banner',
					}, [
						h('div', { className: 'dshsd-banner-title', key: 'title' }, counting ? t('statusCountdown') : t('statusTitle')),
						...bannerBody,
						eventKey === undefined
							? null
							: h('div', { className: 'dshsd-muted', key: 'event' }, t(eventKey)),
					]),
				]

				children.push(h('div', { key: 'status' }, statusRows))

				// Cancel / immediate rows.
				const armActions = []
				if (counting) {
					armActions.push(h('button', {
						key: 'cancel',
						type: 'button',
						className: 'dshsd-btn dshsd-btn-danger',
						disabled: busy,
						onClick: () => { void send('cancel') },
					}, t('cancel')))
				} else {
					armActions.push(h('button', {
						key: 'arm',
						type: 'button',
						className: 'dshsd-btn dshsd-btn-danger',
						disabled: busy,
						onClick: () => { void send('arm') },
					}, t('armButton')))
					if (state.phase === 'scheduled') {
						armActions.push(h('button', {
							key: 'cancel-schedule',
							type: 'button',
							className: 'dshsd-btn',
							disabled: busy,
							onClick: () => { void send('cancel') },
						}, t('cancelSchedule')))
					}
				}

				children.push(h('div', { className: 'dshsd-row', key: 'arm' }, [
					h('div', { className: 'dshsd-col', key: 'text' }, [
						h('div', { className: 'dshsd-title', key: 'title' }, t('armTitle')),
						h('div', { className: 'dshsd-desc', key: 'desc' }, t('armDesc', { grace })),
					]),
					h('div', { className: 'dshsd-actions', key: 'actions' }, armActions),
				]))

				// Wall-clock schedule row.
				children.push(h('div', { className: 'dshsd-row', key: 'schedule' }, [
					h('div', { className: 'dshsd-col', key: 'text' }, [
						h('div', { className: 'dshsd-title', key: 'title' }, t('scheduleTitle')),
						h('div', { className: 'dshsd-desc', key: 'desc' }, t('scheduleDesc', { grace })),
					]),
					h('div', { className: 'dshsd-actions', key: 'actions' }, [
						h('input', {
							key: 'time',
							type: 'time',
							className: 'dshsd-time',
							value: clock,
							disabled: busy,
							'aria-label': t('scheduleTitle'),
							onChange: (event) => setClock(event.target.value),
						}),
						h('button', {
							key: 'set',
							type: 'button',
							className: 'dshsd-btn',
							disabled: busy || !/^\d{2}:\d{2}$/.test(clock),
							onClick: () => { void send('schedule', { at: clock }) },
						}, t('scheduleButton')),
					]),
				]))

				// Quick delay row.
				const quickActions = [30, 60, 120].map((minutes) => h('button', {
					key: `m${minutes}`,
					type: 'button',
					className: 'dshsd-btn',
					disabled: busy,
					onClick: () => { void send('schedule', { inSeconds: minutes * 60 }) },
				}, t(minutes === 30 ? 'delay30' : minutes === 60 ? 'delay60' : 'delay120')))

				children.push(h('div', { className: 'dshsd-row', key: 'delay' }, [
					h('div', { className: 'dshsd-col', key: 'text' }, [
						h('div', { className: 'dshsd-title', key: 'title' }, t('delayTitle')),
						h('div', { className: 'dshsd-desc', key: 'desc' }, t('delayDesc', { grace })),
					]),
					h('div', { className: 'dshsd-actions', key: 'actions' }, quickActions),
				]))

				// Task-end switch. `runningAgents` arrived in a later host build, so a
				// host that does not report it still gets the neutral wording.
				const running = Number(state.runningAgents)
				const taskEndNote = Number.isFinite(running)
					? (running > 0 ? t('taskEndRunning', { count: running }) : t('taskEndIdle'))
					: t('taskEndWaiting')
				children.push(h(SwitchRow, {
					key: 'taskend',
					title: t('taskEndTitle'),
					description: state.taskEndEnabled ? `${t('taskEndDesc')} ${taskEndNote}` : t('taskEndDesc'),
					checked: state.taskEndEnabled,
					disabled: busy,
					onChange: (next) => { void send('setTaskEnd', { enabled: next }) },
				}))

				// Simulation switch.
				children.push(h(SwitchRow, {
					key: 'dryrun',
					title: t('dryRunTitle'),
					description: t('dryRunDesc'),
					checked: state.dryRun,
					disabled: busy,
					onChange: (next) => { void send('setDryRun', { enabled: next }) },
				}))

				// The exact command this platform runs, for transparency.
				children.push(h('div', { className: 'dshsd-row', key: 'commands' }, [
					h('div', { className: 'dshsd-col', key: 'text' }, [
						h('div', { className: 'dshsd-title', key: 'title' }, t('commandTitle')),
						h('div', { className: 'dshsd-code', key: 'start' }, state.startCommandLine),
						h('div', { className: 'dshsd-code', key: 'cancel' }, `${t('commandCancel')}: ${state.cancelCommandLine}`),
					]),
					busy ? h('div', { className: 'dshsd-muted', key: 'busy' }, t('busy')) : null,
				]))

				return h('div', { className: 'dshsd-root' }, children)
			}
		}

		/** `HH:MM` one minute from now, as the time input's initial value. */
		function defaultClock() {
			const when = new Date(Date.now() + 60000)
			return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
		}

		/**
		 * Localized label for the day a host timestamp falls on.
		 * @param timestamp - epoch milliseconds from the host.
		 * @param zh - whether the active locale is Chinese.
		 * @returns `today`/`明天` label, or the empty string when unknown.
		 */
		function dayLabel(timestamp, zh) {
			if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
			const target = new Date(timestamp)
			const today = new Date()
			const sameDay = target.getFullYear() === today.getFullYear()
				&& target.getMonth() === today.getMonth()
				&& target.getDate() === today.getDate()
			if (sameDay) return zh ? '今天' : 'today'
			const tomorrow = new Date(today.getTime() + 86400000)
			const isTomorrow = target.getFullYear() === tomorrow.getFullYear()
				&& target.getMonth() === tomorrow.getMonth()
				&& target.getDate() === tomorrow.getDate()
			if (isTomorrow) return zh ? '明天' : 'tomorrow'
			return `${target.getMonth() + 1}/${target.getDate()}`
		}

		return {
			name: NS,
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'dsh-shutdown-scheduler: zh dictionary')
				ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'dsh-shutdown-scheduler: en dictionary')
				const t = ctx.locale.bind(NS)
				ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: SECTION_ID,
					order: 90,
					label: () => t('nav'),
				}, makeSection(ctx, t)))
			},
		}
	},
})
