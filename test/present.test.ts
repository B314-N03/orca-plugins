import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextResult, transitionsBetween } from '../src/logic.ts'
import { notificationFor, NOTIFICATION_TITLE_MAX, summaryNotification } from '../src/present.ts'
import { displayUrl } from '../src/url.ts'
import { parseLegacyStore, planSeed } from '../src/seed.ts'
import type { Probe, UptimeResult } from '../src/types.ts'

const target = { name: 'staging', url: 'https://staging.example/health/ready' }
const ok: Probe = { status: 200, ms: 80, body: '{"status":"ok"}', error: null }
const refused: Probe = { status: null, ms: null, body: '', error: 'connection refused' }
const degradedProbe: Probe = { status: 200, ms: 90, body: '{"checks":{"database":"down","cache":"fail"}}', error: null }
const unavailable: Probe = { status: 503, ms: 40, body: '{"checks":{"database":"down"}}', error: null }

const run = (probes: Probe[]) => {
  const seen: UptimeResult[] = []
  let previous: UptimeResult | undefined
  probes.forEach((probe, minute) => {
    previous = nextResult(previous, target, probe, minute * 60_000)
    seen.push(previous)
  })
  return seen
}

const notificationsAcross = (probes: Probe[]) => {
  const seen = run(probes)
  return seen.flatMap((result, index) => {
    const now = index * 60_000
    const before = index === 0 ? [] : [seen[index - 1]!]
    return transitionsBetween(before, [result], now).map(transition => notificationFor(transition, now))
  })
}

test('each transition maps to exactly one notification with a fixed title and body', () => {
  assert.deepEqual(notificationsAcross([ok, refused, refused]), [
    { title: '✗ staging down', body: 'connection refused' },
  ])
  assert.deepEqual(notificationsAcross([ok, degradedProbe]), [
    { title: '⚠ staging degraded', body: 'database, cache' },
  ])
  assert.deepEqual(notificationsAcross([ok, unavailable, unavailable]), [
    { title: '✗ staging down', body: '503 · database' },
  ])
})

test('recovery names how long the problem lasted', () => {
  assert.deepEqual(notificationsAcross([ok, refused, refused, refused, ok]), [
    { title: '✗ staging down', body: 'connection refused' },
    { title: '✓ staging recovered', body: 'after 2m' },
  ])
})

test('the first result, a blip, an unchanged state and a pending row never notify', () => {
  assert.deepEqual(notificationsAcross([refused]), [])
  assert.deepEqual(notificationsAcross([ok, refused, ok]), [])
  assert.deepEqual(notificationsAcross([ok, ok, ok]), [])
  assert.deepEqual(notificationsAcross([unavailable, unavailable, unavailable]), [])
})

test('degraded to down and down to degraded each notify once', () => {
  assert.deepEqual(
    notificationsAcross([ok, degradedProbe, unavailable, unavailable, degradedProbe]).map(n => n.title),
    ['⚠ staging degraded', '✗ staging down', '⚠ staging degraded'],
  )
})

test('a long name is clipped to the notification title limit', () => {
  const long = { ...run([ok, refused, refused])[2]!, name: 'x'.repeat(200) }
  const previous = { ...run([ok])[0]!, name: long.name }
  const [transition] = transitionsBetween([previous], [long], 0)
  const { title } = notificationFor(transition!, 0)
  assert.equal(title.length, NOTIFICATION_TITLE_MAX)
  assert.ok(title.endsWith('…'))
})

test('display URLs drop credentials and query strings', () => {
  const cases: [string, string][] = [
    ['https://staging.example/health/ready', 'https://staging.example/health/ready'],
    ['https://user:secret@staging.example/health', 'https://staging.example/health'],
    ['https://staging.example/health?token=abc123', 'https://staging.example/health?…'],
    ['https://staging.example:8443/health#frag', 'https://staging.example:8443/health'],
    ['http://localhost:3000/', 'http://localhost:3000/'],
    ['not a url?token=abc', 'not a url'],
  ]
  for (const [input, expected] of cases) assert.equal(displayUrl(input), expected, input)
})

test('the legacy mod store seeds targets and the off switch', () => {
  const targets = [{ name: 'staging', url: 'https://staging.example/health' }]
  assert.deepEqual(parseLegacyStore({ targets, isOff: true }), { targets, isOff: true })
  assert.deepEqual(parseLegacyStore({ targets }), { targets, isOff: false })
  assert.deepEqual(parseLegacyStore({ targets, isOff: 'yes' }), { targets, isOff: false })
  assert.equal(parseLegacyStore({ targets: [] }), null)
  assert.equal(parseLegacyStore({ targets: [{ name: 1 }] }), null)
  assert.equal(parseLegacyStore(null), null)
  assert.equal(parseLegacyStore('x'), null)
  assert.equal(parseLegacyStore(undefined), null)
})

test('seeding happens once, so an emptied list stays empty', () => {
  const legacy = { targets: [{ name: 'prod', url: 'https://prod.example/health' }], isOff: false }
  assert.deepEqual(planSeed(undefined, legacy), { targets: legacy.targets, isOff: false })
  assert.deepEqual(planSeed(null, legacy), { targets: legacy.targets, isOff: false })
  assert.equal(planSeed(true, legacy), null)
  assert.equal(planSeed(undefined, null), null)
})

test('the legacy seed drops entries that would fail validation', () => {
  const good = { name: 'prod', url: 'https://prod.example/health' }
  assert.deepEqual(parseLegacyStore({ targets: [good, { name: 'bad name', url: 'https://x.example' }, { name: 'ftp', url: 'ftp://x' }] }), {
    targets: [good],
    isOff: false,
  })
})

test('the summary notification carries the status line and one line per deployment, without URLs', () => {
  const other = { name: 'prod', url: 'https://prod.example/health?token=secret' }
  const down = run([ok, refused, refused])[2]!
  const prodUp = { ...run([ok])[0]!, name: 'prod', url: other.url }
  assert.deepEqual(summaryNotification([target, other], [down, prodUp], 2 * 60_000, false), {
    title: 'uptime 1/2 · staging ✗',
    body: '✗ staging  down for just now · connection refused\n✓ prod  up for 2m · 200 · 80 ms',
  })
  assert.deepEqual(summaryNotification([], [], 0, false), { title: 'uptime: no deployments', body: 'No deployments yet.' })
  assert.deepEqual(summaryNotification([target], [], 0, false), { title: 'uptime …', body: '… staging  not checked yet' })
  assert.equal(summaryNotification([target], [down], 0, true).title, 'uptime is off')
})
