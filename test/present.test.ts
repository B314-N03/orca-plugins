import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextResult, transitionsBetween } from '../src/logic.ts'
import { notificationFor, NOTIFICATION_TITLE_MAX, offReport, snapshotOf, statusBarFor, statusReport } from '../src/present.ts'
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

test('the legacy mod store seeds the targets, never the off switch', () => {
  const targets = [{ name: 'staging', url: 'https://staging.example/health' }]
  assert.deepEqual(parseLegacyStore({ targets, isOff: true }), { targets })
  assert.deepEqual(parseLegacyStore({ targets }), { targets })
  assert.equal(parseLegacyStore({ targets: [] }), null)
  assert.equal(parseLegacyStore({ targets: [{ name: 1 }] }), null)
  assert.equal(parseLegacyStore(null), null)
  assert.equal(parseLegacyStore('x'), null)
  assert.equal(parseLegacyStore(undefined), null)
})

test('seeding happens once, so an emptied list stays empty', () => {
  const legacy = { targets: [{ name: 'prod', url: 'https://prod.example/health' }], isOff: false }
  assert.deepEqual(planSeed(undefined, legacy), { targets: legacy.targets })
  assert.deepEqual(planSeed(null, legacy), { targets: legacy.targets })
  assert.equal(planSeed(true, legacy), null)
  assert.equal(planSeed(undefined, null), null)
})

test('the legacy seed drops entries that would fail validation', () => {
  const good = { name: 'prod', url: 'https://prod.example/health' }
  assert.deepEqual(parseLegacyStore({ targets: [good, { name: 'bad name', url: 'https://x.example' }, { name: 'ftp', url: 'ftp://x' }] }), {
    targets: [good],
  })
})

const state = (results: UptimeResult[], isOff = false, targets = [target, other]) => ({ targets, results, isOff, now: 2 * 60_000 })
const other = { name: 'prod', url: 'https://user:pw@prod.example/health?token=secret' }

test('the status bar item carries the status line, a tone for the worst state and the problems as tooltip', () => {
  const down = run([ok, refused, refused])[2]!
  const prodUp = { ...run([ok])[0]!, name: 'prod', url: other.url }
  const degraded = { ...run([degradedProbe])[0]!, name: 'prod', url: other.url }
  assert.deepEqual(statusBarFor(state([down, prodUp])), {
    id: 'uptime',
    text: 'uptime 1/2 · staging ✗',
    tone: 'danger',
    tooltip: 'staging down (connection refused)',
    visible: true,
  })
  assert.deepEqual(statusBarFor(state([{ ...prodUp, name: 'staging', url: target.url }, degraded])), {
    id: 'uptime',
    text: 'uptime 1/2 · prod ⚠',
    tone: 'warning',
    tooltip: 'prod degraded (database, cache)',
    visible: true,
  })
  assert.deepEqual(statusBarFor(state([{ ...prodUp, name: 'staging', url: target.url }, prodUp])), {
    id: 'uptime',
    text: 'uptime 2/2 ✓',
    tone: 'success',
    tooltip: 'Deployment uptime · press to check now',
    visible: true,
  })
  assert.equal(statusBarFor(state([])).tone, 'neutral')
  assert.equal(statusBarFor(state([])).text, 'uptime …')
  assert.equal(statusBarFor(state([], false, [])).text, 'uptime: no deployments')
  assert.equal(statusBarFor(state([down], true)).visible, false)
})

test('the panel snapshot has one row per deployment in list order, with redacted URLs', () => {
  const prodUp = { ...run([ok])[0]!, name: 'prod', url: other.url, checkedAt: 90_000 }
  const snapshot = snapshotOf(state([prodUp]), 60_000)
  assert.equal(snapshot.isOff, false)
  assert.equal(snapshot.pollMs, 60_000)
  assert.equal(snapshot.checkedAt, 90_000)
  assert.deepEqual(snapshot.deployments.map(d => [d.name, d.health, d.url]), [
    ['staging', 'unknown', 'https://staging.example/health/ready'],
    ['prod', 'up', 'https://prod.example/health?…'],
  ])
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|user:pw/)
  assert.equal(snapshotOf(state([]), 60_000).checkedAt, null)
})

test('commands answer with the status line and the list; while off, with the last known results', () => {
  const down = run([ok, refused, refused])[2]!
  assert.equal(
    statusReport(state([down])),
    'uptime 0/2 · staging ✗\n✗ staging  down for just now · connection refused  https://staging.example/health/ready\n… prod  not checked yet  https://prod.example/health?…',
  )
  assert.match(statusReport(state([down], true)), /^uptime is off: last known results/)
  assert.equal(
    offReport(),
    'uptime off. No checks, no notifications and no status bar item, also after a restart. Run "Uptime: Turn on" to resume.',
  )
})
