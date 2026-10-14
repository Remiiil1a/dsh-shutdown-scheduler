/**
 * Host half of `dsh-shutdown-scheduler`.
 *
 * Adds a cancellable, delayed system-shutdown scheduler to the Harness host
 * process:
 *
 *  - `arm`      issues the shutdown command with a grace delay (default 180 s),
 *               so the machine powers off three minutes after the command is
 *               received unless the user cancels.
 *  - `schedule` arms that command at a wall-clock time or after a delay.
 *  - `taskEnd`  arms it once the next agent turn has actually finished.
 *  - `cancel`   rescinds the OS-level countdown through the platform's abort
 *               verb before the deadline.
 *
 * The OS owns the countdown once the command is issued: `shutdown /s /t 180`
 * on Windows and `shutdown -h +N` elsewhere. This host half keeps the mirror
 * state the Client renders; it never depends on being alive at the deadline.
 *
 * The Client half talks to this file over one fenced HTTP route, because an
 * installed bundle's browser half has no package-private RPC bridge.
 */

import { execFile } from 'node:child_process'

/** HTTP path prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-shutdown'

/** Largest accepted request body. */
const BODY_LIMIT = 64 * 1024

/** Tunables a Loader row `config` may override. */
const DEFAULTS = {
	/** Grace delay in seconds between issuing the command and the shutdown. */
	graceSeconds: 180,
	/** Simulate instead of running the command; togglable at runtime. */
	dryRun: false,
	/** Executable for the shutdown command (default: platform `shutdown`). */
	startBinary: '',
	/** Executable for the abort command (default: platform `shutdown`). */
	cancelBinary: '',
	/** Explicit argv for the shutdown command; `null` uses the platform default. */
	startArgs: null,
	/** Explicit argv for the abort command; `null` uses the platform default. */
	cancelArgs: null,
	/** Windows `/c` comment shown in the pending-shutdown notice. */
	comment: 'DeepSeek Harness scheduled shutdown. Run "shutdown /a" to cancel.',
}

/** An error carrying the wire code the Client surfaces. */
class ApiError extends Error {
	constructor(code, message) {
		super(message)
		this.code = code
	}
}

/**
 * Resolve the effective tunables from a Loader row config.
 * @param config - raw row config, possibly undefined.
 * @returns the resolved tunables.
 */
function resolveConfig(config) {
	const raw = config !== null && typeof config === 'object' ? config : {}
	const grace = Number(raw.graceSeconds)
	return {
		graceSeconds: Number.isFinite(grace) && grace >= 0 ? Math.min(Math.floor(grace), 86400) : DEFAULTS.graceSeconds,
		dryRun: raw.dryRun === true,
		startBinary: typeof raw.startBinary === 'string' && raw.startBinary !== '' ? raw.startBinary : '',
		cancelBinary: typeof raw.cancelBinary === 'string' && raw.cancelBinary !== '' ? raw.cancelBinary : '',
		startArgs: Array.isArray(raw.startArgs) ? raw.startArgs.map(String) : null,
		cancelArgs: Array.isArray(raw.cancelArgs) ? raw.cancelArgs.map(String) : null,
		comment: typeof raw.comment === 'string' && raw.comment !== '' ? raw.comment : DEFAULTS.comment,
	}
}

/** Whether this host is Windows. */
function isWindows() {
	return process.platform === 'win32'
}

/**
 * Render one command as a single readable line.
 * @param binary - executable name or path.
 * @param args - argv passed to it.
 * @returns the display form, with spaced arguments quoted.
 */
function commandLine(binary, args) {
	return [binary, ...args]
		.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
		.join(' ')
}

/**
 * Decide whether one request may reach this plugin's route: the browser must
 * have sent it from the same origin the page was served from. A cross-site
 * request is refused, which is what stops a foreign page from powering the
 * machine off through a form post.
 * @param req - node HTTP request.
 * @returns whether the request is same-origin.
 */
function isTrustedRequest(req) {
	const host = req.headers.host
	if (typeof host !== 'string' || host === '') return false
	if (req.headers['sec-fetch-site'] === 'cross-site') return false
	const origin = req.headers.origin
	if (origin === undefined) return true
	try {
		const parsed = new URL(origin)
		return parsed.host === host || parsed.hostname === host.replace(/:\d+$/, '')
	} catch {
		return false
	}
}

/**
 * Read and parse a JSON request body.
 * @param req - node HTTP request.
 * @returns the parsed body, or an empty object for an empty body.
 * @throws {ApiError} when the body is too large or is not JSON.
 */
async function readJson(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > BODY_LIMIT) throw new ApiError('body-too-large', 'request body exceeds 64 KiB')
		chunks.push(chunk)
	}
	if (size === 0) return {}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		return parsed !== null && typeof parsed === 'object' ? parsed : {}
	} catch {
		throw new ApiError('bad-json', 'request body is not JSON')
	}
}

/**
 * Write one JSON response.
 * @param res - node HTTP response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function send(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(text),
		'cache-control': 'no-store',
	})
	res.end(text)
}

/** Format a millisecond remainder as `m:ss` for the wire. */
function formatRemaining(ms) {
	const total = Math.max(0, Math.ceil(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Host half body.
 * @param ctx - host plugin context; must carry `webServer`.
 * @param config - Loader row config.
 */
export function apply(ctx, config) {
	const cfg = resolveConfig(config)
	const grace = cfg.graceSeconds

	/** Mirror state the Client renders; the OS owns the real countdown. */
	const state = {
		phase: 'idle',
		source: null,
		deadlineAt: 0,
		scheduleAt: 0,
		scheduleLabel: '',
		scheduleSource: null,
		taskEndEnabled: false,
		taskSeen: false,
		dryRun: cfg.dryRun,
		commandIssued: false,
		lastEvent: 'ready',
		lastEventAt: Date.now(),
		lastCommand: null,
		lastError: null,
		/** Agent lifecycle transitions observed since this host half loaded. */
		agentTransitions: { running: 0, idle: 0 },
		lastAgentEventAt: 0,
	}

	let scheduleTimer = null
	let graceTimer = null

	const startBinary = () => cfg.startBinary !== '' ? cfg.startBinary : 'shutdown'
	const cancelBinary = () => cfg.cancelBinary !== '' ? cfg.cancelBinary : 'shutdown'

	/** Argv that issues the shutdown with its grace delay. */
	function startArgs() {
		if (cfg.startArgs !== null) return cfg.startArgs
		if (isWindows()) return ['/s', '/t', String(grace), '/c', cfg.comment]
		return ['-h', `+${Math.max(1, Math.ceil(grace / 60))}`]
	}

	/** Argv that rescinds a pending shutdown. */
	function cancelArgs() {
		if (cfg.cancelArgs !== null) return cfg.cancelArgs
		return isWindows() ? ['/a'] : ['-c']
	}

	function clearScheduleTimer() {
		if (scheduleTimer !== null) {
			clearTimeout(scheduleTimer)
			scheduleTimer = null
		}
	}

	function clearGraceTimer() {
		if (graceTimer !== null) {
			clearTimeout(graceTimer)
			graceTimer = null
		}
	}

	/**
	 * Run one command, or record it without running when simulating.
	 * @param binary - executable.
	 * @param args - argv.
	 * @returns the outcome, including the display line.
	 */
	function runCommand(binary, args) {
		const line = commandLine(binary, args)
		if (state.dryRun) {
			state.lastCommand = { line, ok: true, error: null, at: Date.now(), dryRun: true }
			return Promise.resolve({ ok: true, line, error: null, dryRun: true })
		}
		return new Promise((resolve) => {
			execFile(binary, args, { windowsHide: true, timeout: 15000 }, (error, _stdout, stderr) => {
				const detail = error === null
					? null
					: (typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error.message)
				state.lastCommand = { line, ok: error === null, error: detail, at: Date.now(), dryRun: false }
				if (error !== null) state.lastError = detail
				resolve({ ok: error === null, line, error: detail, dryRun: false })
			})
		})
	}

	/**
	 * Rescind the OS-level countdown this plugin issued.
	 * @returns the command outcome, or `null` when nothing was issued.
	 */
	async function abortIssuedShutdown() {
		if (!state.commandIssued) return null
		state.commandIssued = false
		return runCommand(cancelBinary(), cancelArgs())
	}

	/** The wire projection of the mirror state. */
	function snapshot() {
		const now = Date.now()
		const remainingMs = state.phase === 'countdown' ? Math.max(0, state.deadlineAt - now) : 0
		return {
			phase: state.phase,
			source: state.source,
			graceSeconds: grace,
			remainingMs,
			remaining: remainingMs > 0 ? formatRemaining(remainingMs) : '0:00',
			scheduledInMs: state.phase === 'scheduled' ? Math.max(0, state.scheduleAt - now) : 0,
			scheduledAt: state.phase === 'scheduled' ? state.scheduleAt : 0,
			scheduleLabel: state.scheduleLabel,
			scheduleSource: state.scheduleSource,
			taskEndEnabled: state.taskEndEnabled,
			taskSeen: state.taskSeen,
			runningAgents: countRunning(),
			agentTransitions: { ...state.agentTransitions },
			lastAgentEventAt: state.lastAgentEventAt,
			dryRun: state.dryRun,
			platform: process.platform,
			startCommandLine: commandLine(startBinary(), startArgs()),
			cancelCommandLine: commandLine(cancelBinary(), cancelArgs()),
			lastEvent: state.lastEvent,
			lastEventAt: state.lastEventAt,
			lastCommand: state.lastCommand,
			lastError: state.lastError,
		}
	}

	/** Fired at the deadline; the OS performs the actual shutdown. */
	function onGraceElapsed() {
		graceTimer = null
		state.phase = 'idle'
		state.source = null
		state.deadlineAt = 0
		state.commandIssued = false
		state.lastEvent = state.dryRun ? 'executed-dry-run' : 'executed'
		state.lastEventAt = Date.now()
		ctx.logger?.info?.('dsh-shutdown-scheduler: grace window elapsed; the platform shutdown command is due now')
	}

	/**
	 * Issue the shutdown command and start the grace countdown.
	 * @param source - who asked: `manual`, `schedule`, or `task-end`.
	 * @returns the command outcome.
	 */
	async function arm(source) {
		clearScheduleTimer()
		clearGraceTimer()
		await abortIssuedShutdown()
		const result = await runCommand(startBinary(), startArgs())
		if (!result.ok && !state.dryRun) {
			state.phase = 'idle'
			state.source = null
			state.deadlineAt = 0
			state.lastEvent = 'arm-failed'
			state.lastEventAt = Date.now()
			return result
		}
		state.phase = 'countdown'
		state.source = source
		state.scheduleAt = 0
		state.scheduleLabel = ''
		state.scheduleSource = null
		state.deadlineAt = Date.now() + grace * 1000
		state.commandIssued = !result.dryRun
		state.lastEvent = 'armed'
		state.lastEventAt = Date.now()
		graceTimer = setTimeout(onGraceElapsed, Math.max(0, grace * 1000))
		return result
	}

	/**
	 * Clear every pending timer and rescind the issued shutdown.
	 * @param reason - the `lastEvent` value describing why.
	 * @returns whether a countdown was running and how the abort went.
	 */
	async function cancelActive(reason) {
		const previous = {
			phase: state.phase,
			source: state.source,
			deadlineAt: state.deadlineAt,
			scheduleAt: state.scheduleAt,
			scheduleLabel: state.scheduleLabel,
			scheduleSource: state.scheduleSource,
			// Kept so a failed abort leaves the issue flag set and the next
			// cancel attempt retries the platform abort instead of skipping it.
			commandIssued: state.commandIssued,
		}
		clearGraceTimer()
		clearScheduleTimer()
		const abort = await abortIssuedShutdown()
		if (abort !== null && !abort.ok) {
			// The platform still holds the countdown: report it instead of
			// pretending the machine is safe.
			Object.assign(state, previous)
			if (previous.phase === 'countdown' && previous.deadlineAt > Date.now()) {
				graceTimer = setTimeout(onGraceElapsed, previous.deadlineAt - Date.now())
			}
			state.lastEvent = 'cancel-failed'
			state.lastEventAt = Date.now()
			state.lastError = abort.error
			return { wasCountdown: previous.phase === 'countdown', abort }
		}
		state.phase = 'idle'
		state.source = null
		state.deadlineAt = 0
		state.scheduleAt = 0
		state.scheduleLabel = ''
		state.scheduleSource = null
		state.lastEvent = reason
		state.lastEventAt = Date.now()
		state.lastError = null
		return { wasCountdown: previous.phase === 'countdown', abort }
	}

	/**
	 * Arm the shutdown at a wall-clock time or after a delay.
	 * @param payload - `{ at: 'HH:MM' }` or `{ inSeconds: number }`.
	 * @returns the refreshed snapshot.
	 */
	async function scheduleShutdown(payload) {
		const at = typeof payload.at === 'string' ? payload.at.trim() : null
		const inSeconds = Number(payload.inSeconds)
		const now = Date.now()
		let target
		let label = ''
		let source
		if (at !== null) {
			const match = /^(\d{1,2}):(\d{2})$/.exec(at)
			if (match === null) throw new ApiError('bad-argument', 'at must be "HH:MM"')
			const hours = Number(match[1])
			const minutes = Number(match[2])
			if (hours > 23 || minutes > 59) throw new ApiError('bad-argument', 'at must be a valid 24-hour time')
			const when = new Date(now)
			when.setSeconds(0, 0)
			when.setHours(hours, minutes, 0, 0)
			if (when.getTime() <= now) when.setDate(when.getDate() + 1)
			target = when.getTime()
			label = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
			source = 'clock'
		} else if (Number.isFinite(inSeconds) && inSeconds > 0) {
			target = now + Math.min(Math.floor(inSeconds), 30 * 24 * 3600) * 1000
			source = 'delay'
		} else {
			throw new ApiError('bad-argument', 'payload needs { at: "HH:MM" } or { inSeconds: n }')
		}
		const cleared = await cancelActive('rescheduled')
		if (cleared.abort !== null && !cleared.abort.ok) {
			// The platform still holds the previous countdown; refuse the new
			// schedule instead of reporting a state the machine is not in.
			throw new ApiError('cancel-failed', `the pending shutdown could not be rescinded: ${cleared.abort.error ?? 'unknown error'}`)
		}
		state.phase = 'scheduled'
		state.source = null
		state.scheduleAt = target
		state.scheduleLabel = label
		state.scheduleSource = source
		state.lastEvent = 'scheduled'
		state.lastEventAt = Date.now()
		state.lastError = null
		scheduleTimer = setTimeout(() => {
			scheduleTimer = null
			void arm('schedule')
		}, Math.max(0, target - Date.now()))
		return snapshot()
	}

	/** Whether any live agent other than `exclude` is still running. */
	function othersRunning(exclude) {
		const agents = ctx.get('agents')
		if (agents === undefined || agents === null) return false
		try {
			return agents.list().some((agent) => agent !== exclude && agent.status === 'running')
		} catch {
			return false
		}
	}

	/** How many live agents the host currently reports as running. */
	function countRunning() {
		const agents = ctx.get('agents')
		if (agents === undefined || agents === null) return 0
		try {
			return agents.list().filter((agent) => agent.status === 'running').length
		} catch {
			return 0
		}
	}

	/** Whether any live agent is running. */
	function anyRunning() {
		return othersRunning(undefined)
	}

	/**
	 * Enable or disable shutdown-after-task-end.
	 * @param enabled - the new switch value.
	 * @returns the refreshed snapshot.
	 */
	function setTaskEnd(enabled) {
		state.taskEndEnabled = enabled === true
		if (!state.taskEndEnabled) {
			state.taskSeen = false
		} else if (anyRunning()) {
			// A task is mid-flight: its end is the trigger.
			state.taskSeen = true
		}
		state.lastEvent = state.taskEndEnabled ? 'task-end-enabled' : 'task-end-disabled'
		state.lastEventAt = Date.now()
		return snapshot()
	}

	/**
	 * Switch simulation mode; any pending shutdown is rescinded first so the
	 * toggle can never leave a real command armed while reporting simulation.
	 * @param enabled - the new switch value.
	 * @returns the refreshed snapshot.
	 */
	async function setDryRun(enabled) {
		const cleared = await cancelActive('dry-run-changed')
		state.dryRun = enabled === true
		if (cleared.abort === null || cleared.abort.ok) {
			state.lastEvent = state.dryRun ? 'dry-run-enabled' : 'dry-run-disabled'
			state.lastEventAt = Date.now()
		}
		return snapshot()
	}

	/**
	 * Observe agent lifecycle transitions for the task-end trigger.
	 * @param payload - the `agent/status` payload.
	 */
	function onAgentStatus(payload) {
		const status = payload?.status
		const agent = payload?.agent
		if (status === 'running') {
			state.agentTransitions.running += 1
			state.lastAgentEventAt = Date.now()
			if (state.taskEndEnabled) state.taskSeen = true
			if (state.phase === 'countdown' && state.source === 'task-end') {
				void cancelActive('task-started')
			}
			return
		}
		if (status !== 'idle') return
		state.agentTransitions.idle += 1
		state.lastAgentEventAt = Date.now()
		if (!state.taskEndEnabled || !state.taskSeen) return
		if (state.phase !== 'idle') return
		if (othersRunning(agent)) return
		state.taskSeen = false
		void arm('task-end')
	}

	/** Wire methods the Client half may call. */
	const methods = {
		state: () => snapshot(),
		arm: async () => {
			await arm('manual')
			return snapshot()
		},
		schedule: (payload) => scheduleShutdown(payload ?? {}),
		cancel: async () => {
			const outcome = await cancelActive('cancelled')
			return { ...snapshot(), wasCountdown: outcome.wasCountdown }
		},
		setTaskEnd: (payload) => setTaskEnd(payload?.enabled),
		setDryRun: (payload) => setDryRun(payload?.enabled),
	}

	/**
	 * The single fenced route: one JSON `{ method, payload }` envelope in, one
	 * `{ ok, value | error }` envelope out.
	 * @param req - node HTTP request.
	 * @param res - node HTTP response.
	 */
	async function handleRequest(req, res) {
		if (!isTrustedRequest(req)) {
			send(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
			return
		}
		if (req.method !== 'POST') {
			send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
			return
		}
		try {
			const body = await readJson(req)
			const method = methods[body.method]
			if (method === undefined) {
				throw new ApiError('unknown-method', `unknown method ${JSON.stringify(body.method)}`)
			}
			const value = await method(body.payload)
			send(res, 200, { ok: true, value })
		} catch (error) {
			const code = error instanceof ApiError ? error.code : 'internal'
			const message = error instanceof Error ? error.message : String(error)
			if (code === 'internal') ctx.logger?.warn?.(`dsh-shutdown-scheduler: ${message}`)
			send(res, code === 'internal' ? 500 : 400, { ok: false, error: { code, message } })
		}
	}

	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRequest }),
		'dsh-shutdown-scheduler: control route',
	)
	ctx.effect(() => ctx.on('agent/status', onAgentStatus), 'dsh-shutdown-scheduler: task-end trigger')
	ctx.effect(() => () => {
		clearScheduleTimer()
		clearGraceTimer()
	}, 'dsh-shutdown-scheduler: timer teardown')
}

/** This host half cannot work without the HTTP carrier. */
export const inject = ['webServer']
