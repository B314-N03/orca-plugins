import {
  describeProblem,
  formatSince,
  isProblem,
  listText,
  OFF_MESSAGE,
  pendingResult,
  reason,
  statusText,
  type Transition,
} from './logic.ts'
import type { UptimeResult, UptimeTarget } from './types.ts'
import { displayUrl } from './url.ts'

export const NOTIFICATION_TITLE_MAX = 120
export const NOTIFICATION_BODY_MAX = 1000
const TOOLTIP_MAX = 300

export type Notification = { title: string; body: string }

type StateView = { targets: readonly UptimeTarget[]; results: readonly UptimeResult[]; isOff: boolean; now: number }

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const NOTIFICATION_ICON = { down: '✗', degraded: '⚠', recovered: '✓' } as const

const transitionBody = (transition: Transition, now: number) => {
  if (transition.kind === 'recovered') return `after ${formatSince(transition.previous.since, now)}`
  if (transition.kind === 'degraded') return transition.result.failing.join(', ')
  return reason(transition.result)
}

export const notificationFor = (transition: Transition, now: number): Notification => ({
  title: clip(`${NOTIFICATION_ICON[transition.kind]} ${transition.result.name} ${transition.kind}`, NOTIFICATION_TITLE_MAX),
  body: clip(transitionBody(transition, now), NOTIFICATION_BODY_MAX),
})

// What the palette commands answer with; Orca shows a string result as is.
export const statusReport = ({ targets, results, isOff, now }: StateView) =>
  isOff ? listText(targets, results, now, true) : `${statusText(targets, results)}\n${listText(targets, results, now)}`

export const offReport = () => `uptime off. ${OFF_MESSAGE}`

export type StatusBarTone = 'neutral' | 'success' | 'warning' | 'danger'

export type StatusBarUpdate = {
  id: string
  text: string
  tone: StatusBarTone
  tooltip: string
  visible: boolean
}

export const STATUS_BAR_ID = 'uptime'

const toneOf = (results: readonly UptimeResult[]): StatusBarTone => {
  if (results.some(result => result.health === 'down')) return 'danger'
  if (results.some(result => result.health === 'degraded')) return 'warning'
  return results.some(result => result.health === 'up') ? 'success' : 'neutral'
}

// Off hides the item; every update carries all fields so turning on shows it again.
export const statusBarFor = ({ targets, results, isOff }: StateView): StatusBarUpdate => {
  const problems = results.filter(isProblem)
  const tooltip = problems.length > 0 ? problems.map(describeProblem).join('\n') : 'Deployment uptime · press to check now'
  return {
    id: STATUS_BAR_ID,
    text: statusText(targets, results),
    tone: toneOf(results),
    tooltip: clip(tooltip, TOOLTIP_MAX),
    visible: !isOff,
  }
}

export type Snapshot = {
  isOff: boolean
  pollMs: number
  checkedAt: number | null
  deployments: UptimeResult[]
}

// What the panel gets: one row per deployment in list order, URLs already redacted.
export const snapshotOf = ({ targets, results, isOff, now }: StateView, pollMs: number): Snapshot => {
  const deployments = targets.map(target => {
    const result = results.find(one => one.name === target.name) ?? pendingResult(target, now)
    return { ...result, url: displayUrl(target.url) }
  })
  const checked = results.filter(result => result.health !== 'unknown').map(result => result.checkedAt)
  return { isOff, pollMs, checkedAt: checked.length > 0 ? Math.max(...checked) : null, deployments }
}
