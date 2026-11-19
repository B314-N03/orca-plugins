import { formatSince, listText, reason, statusText, type Transition } from './logic.ts'
import type { UptimeResult, UptimeTarget } from './types.ts'

export const NOTIFICATION_TITLE_MAX = 120
export const NOTIFICATION_BODY_MAX = 1000

export type Notification = { title: string; body: string }

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const notification = (title: string, body: string): Notification => ({
  title: clip(title, NOTIFICATION_TITLE_MAX),
  body: clip(body, NOTIFICATION_BODY_MAX),
})

const NOTIFICATION_ICON = { down: '✗', degraded: '⚠', recovered: '✓' } as const

const transitionBody = (transition: Transition, now: number) => {
  if (transition.kind === 'recovered') return `after ${formatSince(transition.previous.since, now)}`
  if (transition.kind === 'degraded') return transition.result.failing.join(', ')
  return reason(transition.result)
}

export const notificationFor = (transition: Transition, now: number): Notification =>
  notification(
    `${NOTIFICATION_ICON[transition.kind]} ${transition.result.name} ${transition.kind}`,
    transitionBody(transition, now),
  )

// What "Check now" and "Show status" answer with, since this Orca has no status bar.
export const summaryNotification = (
  targets: readonly UptimeTarget[],
  results: readonly UptimeResult[],
  now: number,
  isOff: boolean,
): Notification =>
  notification(
    isOff ? 'uptime is off' : statusText(targets, results),
    listText(targets, results, now, isOff, { showUrls: false }),
  )
