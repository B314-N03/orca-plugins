import {
  nextResult,
  parseResults,
  parseTargets,
  pendingResult,
  transitionsBetween,
  upsertTarget,
  validateTarget,
} from './logic.ts'
import { notificationFor, type Notification } from './present.ts'
import { probe, type FetchFn } from './probe.ts'
import { planSeed } from './seed.ts'
import type { UptimeResult, UptimeTarget } from './types.ts'

export const POLL_MS = 60_000

export const STORAGE_KEYS = {
  targets: 'targets',
  isOff: 'isOff',
  seeded: 'seededFromMod',
  lastResults: 'lastResults',
} as const

export type UptimeState = {
  targets: UptimeTarget[]
  results: UptimeResult[]
  isOff: boolean
  now: number
}

export type Change<T> = { ok: true; state: T } | { ok: false; message: string }

// Everything the core needs from its host; the Orca worker adapts its own API to these.
export type UptimeDeps = {
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> }
  notify: (notification: Notification) => Promise<unknown>
  publish: (state: UptimeState) => void
  fetch: FetchFn
  now: () => number
  every: (ms: number, tick: () => void) => () => void
  readLegacy: () => Promise<unknown>
  log: (message: string) => void
}

export type Uptime = ReturnType<typeof createUptime>

const sameTarget = (target: UptimeTarget) => (result: UptimeResult) =>
  result.name === target.name && result.url === target.url

export const createUptime = (deps: UptimeDeps) => {
  let results: UptimeResult[] = []
  let inFlight: Promise<void> | null = null
  let stopPolling: (() => void) | null = null
  let ready: Promise<void> = Promise.resolve()
  let disposed = false

  const reportError = (what: string) => (error: unknown) =>
    deps.log(`${what} failed: ${String((error as Error)?.message ?? error).split('\n')[0]}`)

  const notify = (notification: Notification) => deps.notify(notification).catch(reportError('notification'))
  const loadTargets = async () => parseTargets(await deps.storage.get(STORAGE_KEYS.targets))
  const loadIsOff = async () => (await deps.storage.get(STORAGE_KEYS.isOff)) === true

  // While off and before any check of this run, the last results stored by an earlier run are shown.
  const state = async (): Promise<UptimeState> => {
    const isOff = await loadIsOff()
    const shown =
      isOff && results.length === 0 ? parseResults(await deps.storage.get(STORAGE_KEYS.lastResults)) : results
    return { targets: await loadTargets(), results: shown, isOff, now: deps.now() }
  }

  const publish = async () => {
    const current = await state()
    deps.publish(current)
    return current
  }

  const seed = async () => {
    if ((await deps.storage.get(STORAGE_KEYS.seeded)) === true) return
    const existing = await deps.storage.get(STORAGE_KEYS.targets)
    const hasList = existing !== null && existing !== undefined
    const plan = planSeed(hasList, hasList ? null : await deps.readLegacy())
    if (plan) {
      await deps.storage.set(STORAGE_KEYS.targets, plan.targets)
      deps.log(`seeded ${plan.targets.length} deployments from the Claude Code mod`)
    }
    await deps.storage.set(STORAGE_KEYS.seeded, true)
  }

  const checkAll = async () => {
    const targets = await loadTargets()
    const before = results
    const probes = await Promise.all(targets.map(target => probe(deps.fetch, target.url, deps.now)))
    const now = deps.now()
    const checked = targets.map((target, index) =>
      nextResult(before.find(sameTarget(target)), target, probes[index]!, now),
    )
    // The list may have changed while the probes ran: removed ones drop out, added ones stay pending.
    const current = await loadTargets()
    results = current.map(target => checked.find(sameTarget(target)) ?? pendingResult(target, now))
    await deps.storage.set(STORAGE_KEYS.lastResults, results)
    for (const transition of transitionsBetween(before, checked, now)) await notify(notificationFor(transition, now))
    await publish()
  }

  // A check asked for while one runs joins it instead of starting another.
  const refresh = (): Promise<void> => {
    if (!inFlight) {
      inFlight = checkAll().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  const refreshInBackground = () => void refresh().catch(reportError('check'))

  const startPolling = () => {
    if (disposed) return
    stopPolling ??= deps.every(POLL_MS, refreshInBackground)
  }

  const stop = () => {
    stopPolling?.()
    stopPolling = null
  }

  // Orca may stop the worker while start() is still awaiting storage; no timer may outlive that.
  const dispose = () => {
    disposed = true
    stop()
  }

  const start = () => {
    ready = seed()
      .catch(reportError('seed'))
      .then(async () => {
        await publish()
        if (await loadIsOff()) return
        startPolling()
        refreshInBackground()
      })
    return ready
  }

  const checkNow = async () => {
    await ready
    if (!(await loadIsOff())) {
      startPolling()
      await refresh()
    }
    return state()
  }

  const currentState = async () => {
    await ready
    if (inFlight) await inFlight.catch(() => undefined)
    return state()
  }

  const add = async (name: string, url: string): Promise<Change<UptimeState>> => {
    await ready
    const validation = validateTarget(name, url)
    if (!validation.ok) return validation
    const { target } = validation
    await deps.storage.set(STORAGE_KEYS.targets, upsertTarget(await loadTargets(), target))
    results = [...results.filter(result => result.name !== target.name), pendingResult(target, deps.now())]
    const published = await publish()
    if (!published.isOff) refreshInBackground()
    return { ok: true, state: published }
  }

  const remove = async (name: string): Promise<Change<UptimeState>> => {
    await ready
    const targets = await loadTargets()
    if (!targets.some(target => target.name === name)) return { ok: false, message: `No deployment named ${name}.` }
    await deps.storage.set(STORAGE_KEYS.targets, targets.filter(target => target.name !== name))
    results = results.filter(result => result.name !== name)
    await deps.storage.set(STORAGE_KEYS.lastResults, results)
    return { ok: true, state: await publish() }
  }

  const setOff = async (isOff: boolean) => {
    await ready
    await deps.storage.set(STORAGE_KEYS.isOff, isOff)
    if (isOff) {
      stop()
      return publish()
    }
    await publish()
    return checkNow()
  }

  return {
    start,
    dispose,
    checkNow,
    state: currentState,
    add,
    remove,
    turnOn: () => setOff(false),
    turnOff: () => setOff(true),
  }
}
