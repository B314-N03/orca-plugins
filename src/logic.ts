import type { Probe, UptimeHealth, UptimeResult, UptimeTarget } from './types.ts'

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

const reason = (result: UptimeResult) => {
  const what = result.status === null ? (result.error ?? 'no response') : String(result.status)
  return result.failing.length > 0 ? `${what} · ${result.failing.join(', ')}` : what
}

export const describeProblem = (result: UptimeResult) =>
  result.health === 'down'
    ? `${result.name} down (${reason(result)})`
    : `${result.name} degraded (${result.failing.join(', ')})`

export const isProblem = (result: UptimeResult) => result.health === 'down' || result.health === 'degraded'

// Toasts on transitions only. A target's first known health is never announced.
export const changesBetween = (before: readonly UptimeResult[], after: readonly UptimeResult[], now: number) => {
  const changes: string[] = []
  for (const result of after) {
    const previous = before.find(one => one.name === result.name)
    if (!previous || previous.health === 'unknown' || result.health === 'unknown') continue
    if (previous.health === result.health) continue
    if (result.health === 'up') changes.push(`${result.name} recovered after ${formatSince(previous.since, now)}`)
    else changes.push(describeProblem(result))
  }
  return changes
}

export const statusText = (targets: readonly UptimeTarget[], results: readonly UptimeResult[]) => {
  if (targets.length === 0) return 'uptime: no deployments (/uptime add <name> <url>)'
  const known = results.filter(result => result.health !== 'unknown')
  if (known.length === 0) return 'uptime …'
  const healthy = known.filter(result => result.health === 'up').length
  const problems = known.filter(isProblem)
  if (problems.length === 0) return `uptime ${healthy}/${targets.length} ✓`
  const named = problems.map(result => `${result.name} ${result.health === 'down' ? '✗' : '⚠'}`).join(' · ')
  return `uptime ${healthy}/${targets.length} · ${named}`
}

const ICON: Record<UptimeHealth, string> = { up: '✓', degraded: '⚠', down: '✗', unknown: '…' }

export const OFF_MESSAGE =
  'uptime off: no checks, no status line, no band, pane closed (also in new sessions). /uptime on to bring it back.'

// While off nothing is checked, so the list says so and dates each result by
// its last check instead of claiming a live "up for 6m".
export const listText = (
  targets: readonly UptimeTarget[],
  results: readonly UptimeResult[],
  now: number,
  isOff = false,
) => {
  if (targets.length === 0) return 'No deployments yet. Add one with /uptime add <name> <url>.'
  const lines = targets.map(target => {
    const result = results.find(one => one.name === target.name)
    if (!result || result.health === 'unknown') return `… ${target.name}  not checked yet  ${target.url}`
    const latency = result.ms === null ? '' : ` · ${result.ms} ms`
    const when = isOff
      ? `at last check, ${formatSince(result.checkedAt, now)} ago`
      : `for ${formatSince(result.since, now)}`
    return `${ICON[result.health]} ${target.name}  ${result.health} ${when} · ${reason(result)}${latency}  ${target.url}`
  })
  return [...(isOff ? ['uptime is off: last known results, not being checked. /uptime on to resume.'] : []), ...lines].join('\n')
}

export type Command =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'check' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'add'; target: UptimeTarget }
  | { kind: 'remove'; name: string }
  | { kind: 'invalid'; message: string }

const USAGE = 'Use /uptime (pane), /uptime list, /uptime add <name> <url>, /uptime remove <name>, /uptime check, /uptime on|off.'

export const parseCommand = (args: string): Command => {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  switch (verb.toLowerCase()) {
    case '':
      return { kind: 'open' }
    case 'list':
      return { kind: 'list' }
    case 'check':
      return { kind: 'check' }
    case 'on':
      return { kind: 'on' }
    case 'off':
      return { kind: 'off' }
    case 'add': {
      const [name, url] = rest
      if (!name || !url) return { kind: 'invalid', message: 'Use /uptime add <name> <url>.' }
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { kind: 'invalid', message: `Name "${name}": letters, digits, - and _ only.` }
      if (!/^https?:\/\/[^\s/]+/.test(url)) return { kind: 'invalid', message: `"${url}" is not an http(s) URL.` }
      return { kind: 'add', target: { name, url } }
    }
    case 'remove':
      return rest[0] ? { kind: 'remove', name: rest[0] } : { kind: 'invalid', message: 'Use /uptime remove <name>.' }
    default:
      return { kind: 'invalid', message: USAGE }
  }
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
