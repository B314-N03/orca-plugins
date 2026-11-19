import { formatSince, reason, type Transition } from './logic.ts'

export const NOTIFICATION_TITLE_MAX = 120
export const NOTIFICATION_BODY_MAX = 1000

export type Notification = { title: string; body: string }

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const NOTIFICATION_ICON = { down: '✗', degraded: '⚠', recovered: '✓' } as const

const notificationBody = (transition: Transition, now: number) => {
  const { result } = transition
  if (transition.kind === 'recovered') return `after ${formatSince(transition.previous.since, now)}`
  if (transition.kind === 'degraded') return result.failing.join(', ')
  return reason(result)
}

export const notificationFor = (transition: Transition, now: number): Notification => ({
  title: clip(`${NOTIFICATION_ICON[transition.kind]} ${transition.result.name} ${transition.kind}`, NOTIFICATION_TITLE_MAX),
  body: clip(notificationBody(transition, now), NOTIFICATION_BODY_MAX),
})

// Userinfo and query strings can carry credentials, so they never reach the UI or a notification.
export const displayUrl = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '')
  }
  const query = parsed.search ? '?…' : ''
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`
}
