import { nextResult, OFF_MESSAGE, parseResults, parseTargets, transitionsBetween } from './logic.ts'
import { notificationFor, summaryNotification, type Notification } from './present.ts'
import { probe, type FetchFn } from './probe.ts'
import { planSeed } from './seed.ts'
import type { UptimeResult } from './types.ts'

export const POLL_MS = 60_000

export const STORAGE_KEYS = {
  targets: 'targets',
  isOff: 'isOff',
  seeded: 'seededFromMod',
  lastResults: 'lastResults',
} as const

export type HostCall = (method: string, params?: unknown) => Promise<unknown>

export type UptimeDeps = {
  call: HostCall
  fetch: FetchFn
  now: () => number
  every: (ms: number, tick: () => void) => () => void
  readLegacy: () => Promise<unknown>
  log: (message: string) => void
}

export type Uptime = ReturnType<typeof createUptime>

export const createUptime = (deps: UptimeDeps) => {
  let results: UptimeResult[] = []
  let inFlight: Promise<void> | null = null
  let stopPolling: (() => void) | null = null
  let ready: Promise<void> = Promise.resolve()
  let disposed = false

  const reportError = (what: string) => (error: unknown) =>
    deps.log(`${what} failed: ${String((error as Error)?.message ?? error).split('\n')[0]}`)

  const storageGet = async (key: string) => ((await deps.call('storage.get', { key })) as { value?: unknown } | null)?.value
  const storageSet = (key: string, value: unknown) => deps.call('storage.set', { key, value })
  const notify = (notification: Notification) =>
    deps.call('notifications.show', notification).catch(reportError('notification'))

  const loadTargets = async () => parseTargets(await storageGet(STORAGE_KEYS.targets))
  const loadIsOff = async () => (await storageGet(STORAGE_KEYS.isOff)) === true

  const seed = async () => {
    if ((await storageGet(STORAGE_KEYS.seeded)) === true) return
    const existing = await storageGet(STORAGE_KEYS.targets)
    const hasList = existing !== null && existing !== undefined
    const plan = planSeed(hasList, hasList ? null : await deps.readLegacy())
    if (plan) {
      await storageSet(STORAGE_KEYS.targets, plan.targets)
      deps.log(`seeded ${plan.targets.length} deployments from the Claude Code mod`)
    }
    await storageSet(STORAGE_KEYS.seeded, true)
  }

  const checkAll = async () => {
    const targets = await loadTargets()
    const before = results
    const probes = await Promise.all(targets.map(target => probe(deps.fetch, target.url, deps.now)))
    const now = deps.now()
    const after = targets.map((target, index) =>
      nextResult(before.find(one => one.name === target.name && one.url === target.url), target, probes[index]!, now),
    )
    results = after
    // Also what keeps Orca from reaping the worker as idle between checks.
    await storageSet(STORAGE_KEYS.lastResults, after)
    for (const transition of transitionsBetween(before, after, now)) await notify(notificationFor(transition, now))
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

  const startPolling = () => {
    if (disposed) return
    stopPolling ??= deps.every(POLL_MS, () => void refresh().catch(reportError('check')))
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
        if (await loadIsOff()) return
        startPolling()
        void refresh().catch(reportError('check'))
      })
    return ready
  }

  const summary = async () => {
    const isOff = await loadIsOff()
    const shown = isOff && results.length === 0 ? parseResults(await storageGet(STORAGE_KEYS.lastResults)) : results
    const notification = summaryNotification(await loadTargets(), shown, deps.now(), isOff)
    await notify(notification)
    return notification
  }

  const checkNow = async () => {
    await ready
    if (!(await loadIsOff())) {
      startPolling()
      await refresh()
    }
    return summary()
  }

  const showStatus = async () => {
    await ready
    if (inFlight) await inFlight
    return summary()
  }

  const setOff = async (isOff: boolean) => {
    await ready
    await storageSet(STORAGE_KEYS.isOff, isOff)
    if (!isOff) return checkNow()
    stop()
    const notification = { title: 'uptime off', body: OFF_MESSAGE }
    await notify(notification)
    return notification
  }

  return { start, dispose, checkNow, showStatus, turnOn: () => setOff(false), turnOff: () => setOff(true) }
}
