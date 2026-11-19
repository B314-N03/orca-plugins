import type { Probe, UptimeHealth, UptimeResult, UptimeTarget } from './types.ts'
import { displayUrl } from './url.ts'

// A deployment counts as down only after this many failed probes in a row,
// so a single network blip never raises an alert.
export const DOWN_AFTER = 2

const DOWN_WORDS = new Set(['down', 'fail', 'failed', 'error', 'unavailable', 'unhealthy', 'unreachable'])


// Collects the dependencies a JSON health body reports as failing, e.g. the
// `checks` and per-environment maps of a readiness endpoint. Paths keep their
// last two segments: `database`, `PROD_FRA.platformMcp`.
export const failingDependencies = (body: string): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const found: string[] = []
  const walk = (value: unknown, path: string[]) => {
    if (path.length > 4 || value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, key]
      const isTopLevelStatus = path.length === 0 && key === 'status'
      if (typeof child === 'string' && DOWN_WORDS.has(child.toLowerCase()) && !isTopLevelStatus) {
        found.push(childPath.filter(part => part !== 'checks' && part !== 'environments').slice(-2).join('.'))
      } else {
        walk(child, childPath)
      }
    }
  }
  walk(parsed, [])
  return found
}

export const classify = (probe: Probe): { health: UptimeHealth; failing: string[] } => {
  const failing = failingDependencies(probe.body)
  if (probe.status === null || probe.status < 200 || probe.status >= 300) return { health: 'down', failing }
  return { health: failing.length > 0 ? 'degraded' : 'up', failing }
}

// Folds one probe into the previous result. A failed probe keeps the last
// shown health until DOWN_AFTER failures in a row.
export const nextResult = (
  previous: UptimeResult | undefined,
  target: UptimeTarget,
  probe: Probe,
  now: number,
): UptimeResult => {
  const { health: probed, failing } = classify(probe)
  const consecutiveFails = probed === 'down' ? (previous?.consecutiveFails ?? 0) + 1 : 0
  const shownBefore = previous?.health ?? 'unknown'
  const health: UptimeHealth = probed === 'down' && consecutiveFails < DOWN_AFTER ? shownBefore : probed
  return {
    name: target.name,
    url: target.url,
    health,
    status: probe.status,
    ms: probe.ms,
    failing,
    error: probe.error,
    consecutiveFails,
    since: health === shownBefore && previous ? previous.since : now,
    checkedAt: now,
    history: [...(previous?.history ?? []), probed === 'down' ? null : probe.ms].slice(-HISTORY),
  }
}

// The row a target shows between being added and its first probe.
export const pendingResult = (target: UptimeTarget, now: number): UptimeResult => ({
  name: target.name,
  url: target.url,
  health: 'unknown',
  status: null,
  ms: null,
  failing: [],
  error: null,
  consecutiveFails: 0,
  since: now,
  checkedAt: now,
  history: [],
})

export const HISTORY = 30
const BARS = '▁▂▃▄▅▆▇█'

// Latency per check, scaled to the slowest one shown; a failed check is ×.
export const sparkline = (history: readonly (number | null)[]) => {
  const slowest = Math.max(1, ...history.filter((ms): ms is number => ms !== null))
  return history
    .map(ms => (ms === null ? '×' : BARS[Math.min(BARS.length - 1, Math.floor((ms / slowest) * (BARS.length - 1)))]))
    .join('')
}

export const detailText = (result: UptimeResult) => {
  if (result.health === 'unknown') return 'not checked yet'
  const latency = result.ms === null ? '' : ` · ${result.ms} ms`
  return `${reason(result)}${latency}`
}

export const formatSince = (since: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - since) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const reason = (result: UptimeResult) => {
  const what = result.status === null ? (result.error ?? 'no response') : String(result.status)
  return result.failing.length > 0 ? `${what} · ${result.failing.join(', ')}` : what
}

export const describeProblem = (result: UptimeResult) =>
  result.health === 'down'
    ? `${result.name} down (${reason(result)})`
    : `${result.name} degraded (${result.failing.join(', ')})`

export const isProblem = (result: UptimeResult) => result.health === 'down' || result.health === 'degraded'

export type Transition = {
  kind: 'down' | 'degraded' | 'recovered'
  result: UptimeResult
  previous: UptimeResult
  text: string
}

// Announces transitions only. A target's first known health is never announced.
export const transitionsBetween = (
  before: readonly UptimeResult[],
  after: readonly UptimeResult[],
  now: number,
): Transition[] =>
  after.flatMap((result): Transition[] => {
    const previous = before.find(one => one.name === result.name)
    if (!previous || previous.health === 'unknown' || result.health === 'unknown') return []
    if (previous.health === result.health) return []
    if (result.health === 'up') {
      const text = `${result.name} recovered after ${formatSince(previous.since, now)}`
      return [{ kind: 'recovered' as const, result, previous, text }]
    }
    return [{ kind: result.health, result, previous, text: describeProblem(result) }]
  })

export const changesBetween = (before: readonly UptimeResult[], after: readonly UptimeResult[], now: number) =>
  transitionsBetween(before, after, now).map(transition => transition.text)

export const statusText = (targets: readonly UptimeTarget[], results: readonly UptimeResult[]) => {
  if (targets.length === 0) return 'uptime: no deployments'
  const known = results.filter(result => result.health !== 'unknown')
  if (known.length === 0) return 'uptime …'
  const healthy = known.filter(result => result.health === 'up').length
  const problems = known.filter(isProblem)
  if (problems.length === 0) return `uptime ${healthy}/${targets.length} ✓`
  const named = problems.map(result => `${result.name} ${result.health === 'down' ? '✗' : '⚠'}`).join(' · ')
  return `uptime ${healthy}/${targets.length} · ${named}`
}

const ICON: Record<UptimeHealth, string> = { up: '✓', degraded: '⚠', down: '✗', unknown: '…' }

export const TURN_ON_HINT = 'Run "Uptime: Turn on" to resume.'

export const OFF_MESSAGE = `No checks and no notifications, also after a restart. ${TURN_ON_HINT}`

// While off nothing is checked, so the list says so and dates each result by
// its last check instead of claiming a live "up for 6m".
export const listText = (
  targets: readonly UptimeTarget[],
  results: readonly UptimeResult[],
  now: number,
  isOff = false,
  { showUrls = true } = {},
) => {
  if (targets.length === 0) return 'No deployments yet.'
  const urlOf = (target: UptimeTarget) => (showUrls ? `  ${displayUrl(target.url)}` : '')
  const lines = targets.map(target => {
    const result = results.find(one => one.name === target.name)
    if (!result || result.health === 'unknown') return `… ${target.name}  not checked yet${urlOf(target)}`
    const latency = result.ms === null ? '' : ` · ${result.ms} ms`
    const when = isOff
      ? `at last check, ${formatSince(result.checkedAt, now)} ago`
      : `for ${formatSince(result.since, now)}`
    return `${ICON[result.health]} ${target.name}  ${result.health} ${when} · ${reason(result)}${latency}${urlOf(target)}`
  })
  return [...(isOff ? [`uptime is off: last known results, not being checked. ${TURN_ON_HINT}`] : []), ...lines].join('\n')
}

export type TargetValidation = { ok: true; target: UptimeTarget } | { ok: false; message: string }

export const validateTarget = (name: string, url: string): TargetValidation => {
  if (!name || !url) return { ok: false, message: 'A deployment needs a name and a URL.' }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { ok: false, message: `Name "${name}": letters, digits, - and _ only.` }
  if (!/^https?:\/\/[^\s/]+/.test(url)) return { ok: false, message: `"${displayUrl(url)}" is not an http(s) URL.` }
  return { ok: true, target: { name, url } }
}

export const upsertTarget = (targets: readonly UptimeTarget[], target: UptimeTarget) =>
  targets.some(one => one.name === target.name)
    ? targets.map(one => (one.name === target.name ? target : one))
    : [...targets, target]

export const parseTargets = (stored: unknown): UptimeTarget[] =>
  Array.isArray(stored)
    ? stored.filter(
        (one): one is UptimeTarget =>
          typeof one === 'object' && one !== null && typeof one.name === 'string' && typeof one.url === 'string',
      )
    : []

// Results persisted by an earlier run; only shape-checked, since they are only displayed.
export const parseResults = (stored: unknown): UptimeResult[] =>
  Array.isArray(stored)
    ? stored.filter(
        (one): one is UptimeResult =>
          typeof one === 'object' &&
          one !== null &&
          typeof one.name === 'string' &&
          typeof one.url === 'string' &&
          ['up', 'degraded', 'down', 'unknown'].includes(one.health) &&
          Array.isArray(one.history) &&
          Array.isArray(one.failing),
      )
    : []
