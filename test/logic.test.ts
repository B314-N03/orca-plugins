import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Probe, UptimeResult } from '../src/types.ts'
import {
  changesBetween,
  failingDependencies,
  nextResult,
  parseCommand,
  HISTORY,
  listText,
  OFF_MESSAGE,
  parseTargets,
  pendingResult,
  sparkline,
  statusText,
  upsertTarget,
} from '../src/logic.ts'

const target = { name: 'staging', url: 'https://staging.example/health/ready' }
const ok: Probe = { status: 200, ms: 80, body: '{"status":"ok"}', error: null }
const refused: Probe = { status: null, ms: null, body: '', error: 'connection refused' }
const readyBody = JSON.stringify({
  status: 'unavailable',
  checks: { database: 'up', aiEngine: 'down', platformApi: 'up', platformMcp: 'up' },
  environments: { PROD_FRA: { platformApi: 'up', platformMcp: 'down' } },
})

const run = (probes: Probe[]) => {
  const seen: UptimeResult[] = []
  let previous: UptimeResult | undefined
  probes.forEach((probe, minute) => {
    previous = nextResult(previous, target, probe, minute * 60_000)
    seen.push(previous)
  })
  return seen
}

const healths = (results: UptimeResult[]) => results.map(result => result.health)

test('a readiness body names each failing dependency, not its top-level status', () => {
  assert.deepEqual(failingDependencies(readyBody), ['aiEngine', 'PROD_FRA.platformMcp'])
  assert.deepEqual(failingDependencies('not json'), [])
})

test('one failed probe is a blip; the second in a row marks the deployment down', () => {
  assert.deepEqual(healths(run([ok, refused])), ['up', 'up'])
  assert.deepEqual(healths(run([ok, refused, refused])), ['up', 'up', 'down'])
  assert.deepEqual(healths(run([ok, refused, ok, refused])), ['up', 'up', 'up', 'up'])
})

test('a 2xx that reports failing dependencies is degraded, a 503 is down', () => {
  const degraded = run([{ status: 200, ms: 50, body: readyBody, error: null }])[0]!
  assert.equal(degraded.health, 'degraded')
  const down = run([
    { status: 503, ms: 50, body: readyBody, error: null },
    { status: 503, ms: 50, body: readyBody, error: null },
  ])[1]!
  assert.equal(down.health, 'down')
})

test('down and recovery are announced once, the first result never', () => {
  const [first, blip, down, stillDown, recovered] = run([ok, refused, refused, refused, ok])
  assert.deepEqual(changesBetween([], [first!], 0), [])
  assert.deepEqual(changesBetween([first!], [blip!], 0), [])
  assert.deepEqual(changesBetween([blip!], [down!], 0), ['staging down (connection refused)'])
  assert.deepEqual(changesBetween([down!], [stillDown!], 0), [])
  assert.deepEqual(changesBetween([stillDown!], [recovered!], 4 * 60_000), ['staging recovered after 2m'])
})

test('the status line counts healthy deployments and names the broken ones', () => {
  const [up] = run([ok])
  const down = run([ok, refused, refused])[2]!
  const other = { name: 'prod', url: 'https://prod.example/health' }
  assert.equal(statusText([], []), 'uptime: no deployments (/uptime add <name> <url>)')
  assert.equal(statusText([target], []), 'uptime …')
  assert.equal(statusText([target], [up!]), 'uptime 1/1 ✓')
  assert.equal(statusText([target, other], [down, { ...up!, name: 'prod' }]), 'uptime 1/2 · staging ✗')
})

test('commands parse, and bad input answers with a reason', () => {
  assert.deepEqual(parseCommand('add demo https://demo.example/health'), {
    kind: 'add',
    target: { name: 'demo', url: 'https://demo.example/health' },
  })
  assert.equal(parseCommand('add demo ftp://x').kind, 'invalid')
  assert.equal(parseCommand('add de mo').kind, 'invalid')
  assert.deepEqual(parseCommand(' OFF '), { kind: 'off' })
  assert.deepEqual(parseCommand(''), { kind: 'open' })
  assert.deepEqual(parseCommand('list'), { kind: 'list' })
  assert.deepEqual(parseCommand('remove'), { kind: 'invalid', message: 'Use /uptime remove <name>.' })
})

test('adding a known name replaces its URL, and junk in the store is ignored', () => {
  const targets = upsertTarget([target], { name: 'staging', url: 'https://new.example/health' })
  assert.deepEqual(targets, [{ name: 'staging', url: 'https://new.example/health' }])
  assert.deepEqual(parseTargets([target, { name: 1 }, 'x']), [target])
  assert.deepEqual(parseTargets(undefined), [])
})

test('history keeps the latest checks, with failures as gaps', () => {
  const seen = run([ok, refused, ok])
  assert.deepEqual(seen[2]!.history, [80, null, 80])
  const long = run(Array.from({ length: HISTORY + 5 }, () => ok))
  assert.equal(long[long.length - 1]!.history.length, HISTORY)
})

test('the sparkline scales to the slowest check and marks failures', () => {
  assert.equal(sparkline([100, 50, null, 0]), '█▄×▁')
  assert.equal(sparkline([]), '')
})

test('a just-added deployment shows as pending until its first check', () => {
  const pending = pendingResult(target, 0)
  assert.equal(pending.health, 'unknown')
  assert.equal(nextResult(pending, target, ok, 60_000).health, 'up')
})

test('while off, the list says so and dates results by their last check', () => {
  const [up] = run([ok])
  const elevenMinutesLater = 11 * 60_000
  const live = listText([target], [up!], elevenMinutesLater)
  assert.match(live, /up for 11m/)
  const off = listText([target], [up!], elevenMinutesLater, true)
  assert.equal(off.split('\n')[0], 'uptime is off: last known results, not being checked. /uptime on to resume.')
  assert.match(off, /up at last check, 11m ago/)
  assert.doesNotMatch(off, /up for/)
})

test('the off message names everything that stops, the pane included', () => {
  assert.match(OFF_MESSAGE, /pane closed/)
  assert.match(OFF_MESSAGE, /\/uptime on/)
})
