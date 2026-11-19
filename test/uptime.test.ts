import assert from 'node:assert/strict'
import { test } from 'node:test'

import { statusText } from '../src/logic.ts'
import type { Notification } from '../src/present.ts'
import type { FetchFn } from '../src/probe.ts'
import { createUptime, POLL_MS, STORAGE_KEYS, type UptimeState } from '../src/uptime.ts'

type Reply = { status: number; body: string } | 'refused' | 'hang' | 'gate'

const STAGING = { name: 'staging', url: 'https://staging.example/health' }
const PROD = { name: 'prod', url: 'https://prod.example/health' }
const DEMO = { name: 'demo', url: 'https://demo.example/health' }
const OK: Reply = { status: 200, body: '{"status":"ok"}' }

const fakeHost = (initial: Record<string, unknown> = {}) => {
  const storage = new Map<string, unknown>(Object.entries(initial))
  const notifications: Notification[] = []
  const published: UptimeState[] = []
  const writes: string[] = []
  return {
    storage,
    notifications,
    published,
    writes,
    port: {
      get: async (key: string) => (storage.has(key) ? storage.get(key) : null),
      set: async (key: string, value: unknown) => {
        writes.push(key)
        storage.set(key, structuredClone(value))
      },
    },
  }
}

// Each URL answers from its own script; the last reply repeats. 'gate' waits for open().
const fakeFetch = (script: Record<string, Reply[]>) => {
  const requested: string[] = []
  const gates: (() => void)[] = []
  const fetchFn: FetchFn = async url => {
    requested.push(url)
    const replies = script[url] ?? []
    const reply = replies.length > 1 ? replies.shift()! : replies[0]
    if (!reply) throw new Error(`unscripted ${url}`)
    if (reply === 'refused') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    if (reply === 'hang') return new Promise(() => {})
    if (reply === 'gate') {
      await new Promise<void>(resolve => gates.push(resolve))
      return { status: 200, text: async () => '{}' }
    }
    return { status: reply.status, text: async () => reply.body }
  }
  return { fetchFn, requested, open: () => gates.splice(0).forEach(resolve => resolve()) }
}

const setup = ({
  storage = { targets: [STAGING, PROD], seededFromMod: true } as Record<string, unknown>,
  script = { [STAGING.url]: [OK], [PROD.url]: [OK], [DEMO.url]: [OK] } as Record<string, Reply[]>,
  legacy = null as unknown,
} = {}) => {
  const host = fakeHost(storage)
  const net = fakeFetch(script)
  const ticks: (() => void)[] = []
  const logs: string[] = []
  let legacyReads = 0
  let clock = 1_700_000_000_000
  const uptime = createUptime({
    storage: host.port,
    notify: async notification => void host.notifications.push(notification),
    publish: state => void host.published.push(state),
    fetch: net.fetchFn,
    now: () => clock,
    every: (ms, tick) => {
      assert.equal(ms, POLL_MS)
      ticks.push(tick)
      return () => ticks.splice(ticks.indexOf(tick), 1)
    },
    readLegacy: async () => {
      legacyReads += 1
      return legacy
    },
    log: message => logs.push(message),
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const tick = async (minutes = 1) => {
    clock += minutes * 60_000
    for (const run of [...ticks]) run()
    await settle()
  }
  const lastPublished = () => host.published.at(-1)!
  return { uptime, host, net, ticks, logs, tick, settle, lastPublished, legacyReads: () => legacyReads }
}

const healthOf = (state: UptimeState) => Object.fromEntries(state.results.map(result => [result.name, result.health]))

test('the first check after startup never notifies, even for a deployment that is down', async () => {
  const { uptime, host, net, settle } = setup({ script: { [STAGING.url]: ['refused'], [PROD.url]: [OK] } })
  await uptime.start()
  await settle()
  assert.deepEqual(net.requested, [STAGING.url, PROD.url])
  assert.deepEqual(host.notifications, [])
})

test('down after two failed checks, then recovery, each notify exactly once', async () => {
  const { uptime, host, tick, settle } = setup({
    script: { [STAGING.url]: [OK, 'refused', 'refused', 'refused', OK], [PROD.url]: [OK] },
  })
  await uptime.start()
  await settle()
  await tick()
  assert.deepEqual(host.notifications, [], 'one failure is a blip')
  await tick()
  await tick()
  await tick()
  assert.deepEqual(host.notifications, [
    { title: '✗ staging down', body: 'connection refused' },
    { title: '✓ staging recovered', body: 'after 2m' },
  ])
})

test('a 2xx reporting a failing dependency notifies as degraded', async () => {
  const degraded: Reply = { status: 200, body: '{"status":"ok","checks":{"database":"down"}}' }
  const { uptime, host, tick, settle } = setup({ script: { [STAGING.url]: [OK, degraded], [PROD.url]: [OK] } })
  await uptime.start()
  await settle()
  await tick()
  assert.deepEqual(host.notifications, [{ title: '⚠ staging degraded', body: 'database' }])
})

test('start publishes once before checking, then after every check', async () => {
  const { uptime, host, tick, settle } = setup()
  await uptime.start()
  assert.equal(host.published.length, 1)
  assert.equal(statusText(host.published[0]!.targets, host.published[0]!.results), 'uptime …')
  await settle()
  assert.equal(host.published.length, 2)
  assert.equal(statusText(host.published[1]!.targets, host.published[1]!.results), 'uptime 2/2 ✓')
  await tick()
  assert.equal(host.published.length, 3)
})

test('every check stores its results for display after a restart', async () => {
  const { uptime, host, tick, settle } = setup()
  await uptime.start()
  await settle()
  await tick()
  assert.equal(host.writes.filter(key => key === STORAGE_KEYS.lastResults).length, 2)
})

test('the deployment list is seeded once from the mod store and never again', async () => {
  const legacy = { targets: [STAGING], isOff: true }
  const first = setup({ storage: {}, legacy })
  await first.uptime.start()
  assert.deepEqual(first.host.storage.get('targets'), [STAGING])
  assert.equal(first.host.storage.get('isOff'), undefined, 'the mod being off does not switch the plugin off')
  assert.equal(first.ticks.length, 1)
  assert.equal(first.host.storage.get('seededFromMod'), true)
  assert.deepEqual(first.host.notifications, [])

  const emptied = setup({ storage: { targets: [], seededFromMod: true }, legacy })
  await emptied.uptime.start()
  assert.deepEqual(emptied.host.storage.get('targets'), [])
})

test('without a mod store nothing is seeded, but the marker is set', async () => {
  const { uptime, host, net, settle } = setup({ storage: {} })
  await uptime.start()
  await settle()
  assert.equal(host.storage.get('targets'), undefined)
  assert.equal(host.storage.get('seededFromMod'), true)
  assert.deepEqual(net.requested, [])
})

test('once seeded, the mod store is not even read', async () => {
  const { uptime, legacyReads } = setup({ legacy: { targets: [STAGING] } })
  await uptime.start()
  assert.equal(legacyReads(), 0)
})

test('the marker alone prevents a re-seed after the list key is gone', async () => {
  const { uptime, host, legacyReads } = setup({ storage: { seededFromMod: true }, legacy: { targets: [STAGING] } })
  await uptime.start()
  assert.equal(host.storage.get('targets'), undefined)
  assert.equal(legacyReads(), 0)
})

test('an existing list is never overwritten by the seed', async () => {
  const { uptime, host } = setup({ storage: { targets: [PROD] }, legacy: { targets: [STAGING] } })
  await uptime.start()
  assert.deepEqual(host.storage.get('targets'), [PROD])
})

test('turning off persists, stops polling and publishes; turning on checks right away', async () => {
  const { uptime, host, net, ticks, tick, settle, lastPublished } = setup()
  await uptime.start()
  await settle()
  const off = await uptime.turnOff()
  assert.equal(host.storage.get('isOff'), true)
  assert.equal(off.isOff, true)
  assert.equal(lastPublished().isOff, true)
  assert.equal(ticks.length, 0)
  const before = net.requested.length
  await tick(5)
  assert.equal(net.requested.length, before)

  const on = await uptime.turnOn()
  assert.equal(host.storage.get('isOff'), false)
  assert.equal(ticks.length, 1)
  assert.equal(net.requested.length, before + 2)
  assert.equal(on.isOff, false)
  assert.equal(lastPublished().isOff, false)
})

test('a worker started while off neither checks nor polls, and shows the last stored results', async () => {
  const stored = [{ name: 'staging', url: STAGING.url, health: 'up', status: 200, ms: 50, failing: [], error: null, consecutiveFails: 0, since: 1, checkedAt: 2, history: [50] }]
  const { uptime, net, ticks, settle } = setup({
    storage: { targets: [STAGING], seededFromMod: true, isOff: true, lastResults: stored },
  })
  await uptime.start()
  await settle()
  assert.deepEqual(net.requested, [])
  assert.equal(ticks.length, 0)
  assert.deepEqual((await uptime.state()).results, stored)
})

test('Check now joins a check already running instead of probing twice', async () => {
  const { uptime, net, settle } = setup({ script: { [STAGING.url]: ['hang'], [PROD.url]: [OK] } })
  void uptime.start()
  await settle()
  void uptime.checkNow()
  await settle()
  assert.deepEqual(net.requested, [STAGING.url, PROD.url])
})

test('adding validates, stores, shows the new row as pending and checks it', async () => {
  const { uptime, host, net, settle, lastPublished } = setup()
  await uptime.start()
  await settle()
  assert.deepEqual(await uptime.add('de mo', DEMO.url), { ok: false, message: 'Name "de mo": letters, digits, - and _ only.' })
  assert.deepEqual(await uptime.add('demo', 'ftp://demo.example'), { ok: false, message: '"ftp://demo.example/" is not an http(s) URL.' })

  const added = await uptime.add('demo', DEMO.url)
  assert.ok(added.ok)
  assert.deepEqual(host.storage.get('targets'), [STAGING, PROD, DEMO])
  assert.equal(healthOf(added.state).demo, 'unknown')
  await settle()
  assert.ok(net.requested.includes(DEMO.url))
  assert.equal(healthOf(lastPublished()).demo, 'up')
})

test('re-adding a name replaces its URL and starts that row fresh', async () => {
  const { uptime, host, settle } = setup()
  await uptime.start()
  await settle()
  const moved = await uptime.add('prod', DEMO.url)
  assert.ok(moved.ok)
  assert.deepEqual(host.storage.get('targets'), [STAGING, { name: 'prod', url: DEMO.url }])
  assert.equal(healthOf(moved.state).prod, 'unknown')
})

test('removing drops the deployment and its result; an unknown name answers with a reason', async () => {
  const { uptime, host, settle, lastPublished } = setup()
  await uptime.start()
  await settle()
  assert.deepEqual(await uptime.remove('nope'), { ok: false, message: 'No deployment named nope.' })
  const removed = await uptime.remove('staging')
  assert.ok(removed.ok)
  assert.deepEqual(host.storage.get('targets'), [PROD])
  assert.deepEqual(Object.keys(healthOf(lastPublished())), ['prod'])
  assert.deepEqual((host.storage.get('lastResults') as { name: string }[]).map(result => result.name), ['prod'])
})

test('a deployment removed while a check runs does not come back with its result', async () => {
  const { uptime, net, settle, lastPublished } = setup({ script: { [STAGING.url]: ['gate'], [PROD.url]: ['gate'] } })
  void uptime.start()
  await settle()
  await uptime.remove('staging')
  net.open()
  await settle()
  assert.deepEqual(Object.keys(healthOf(lastPublished())), ['prod'])
})

test('a deployment added while a check runs stays pending instead of vanishing', async () => {
  const { uptime, net, settle, lastPublished } = setup({ script: { [STAGING.url]: ['gate'], [PROD.url]: ['gate'], [DEMO.url]: ['hang'] } })
  void uptime.start()
  await settle()
  await uptime.add('demo', DEMO.url)
  net.open()
  await settle()
  assert.deepEqual(healthOf(lastPublished()), { staging: 'up', prod: 'up', demo: 'unknown' })
  assert.deepEqual(lastPublished().results.map(result => result.name), ['staging', 'prod', 'demo'])
})

test('stopping the worker before start() settles leaves no polling timer behind', async () => {
  const { uptime, ticks, settle } = setup()
  void uptime.start()
  uptime.dispose()
  await settle()
  assert.equal(ticks.length, 0)
})
