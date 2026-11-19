import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Notification } from '../src/present.ts'
import type { FetchFn } from '../src/probe.ts'
import { createUptime, POLL_MS, STORAGE_KEYS } from '../src/uptime.ts'

type Reply = { status: number; body: string } | 'refused' | 'hang'

const STAGING = { name: 'staging', url: 'https://staging.example/health' }
const PROD = { name: 'prod', url: 'https://prod.example/health' }
const OK: Reply = { status: 200, body: '{"status":"ok"}' }

const fakeHost = (initial: Record<string, unknown> = {}) => {
  const storage = new Map<string, unknown>(Object.entries(initial))
  const notifications: Notification[] = []
  const writes: string[] = []
  const call = async (method: string, params?: unknown) => {
    const { key, value } = (params ?? {}) as { key: string; value: unknown }
    if (method === 'storage.get') return { value: storage.has(key) ? storage.get(key) : null }
    if (method === 'storage.set') {
      writes.push(key)
      storage.set(key, structuredClone(value))
      return { ok: true }
    }
    if (method === 'notifications.show') {
      notifications.push(params as Notification)
      return { delivered: true }
    }
    throw Object.assign(new Error(`${method} not granted`), { code: 'capability_denied' })
  }
  return { call, storage, notifications, writes }
}

// Each URL answers from its own script; the last reply repeats.
const fakeFetch = (script: Record<string, Reply[]>) => {
  const requested: string[] = []
  const fetchFn: FetchFn = async url => {
    requested.push(url)
    const replies = script[url] ?? []
    const reply = replies.length > 1 ? replies.shift()! : replies[0]
    if (!reply) throw new Error(`unscripted ${url}`)
    if (reply === 'refused') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    if (reply === 'hang') return new Promise(() => {})
    return { status: reply.status, text: async () => reply.body }
  }
  return { fetchFn, requested }
}

const setup = ({
  storage = { targets: [STAGING, PROD], seededFromMod: true } as Record<string, unknown>,
  script = { [STAGING.url]: [OK], [PROD.url]: [OK] } as Record<string, Reply[]>,
  legacy = null as unknown,
} = {}) => {
  const host = fakeHost(storage)
  const net = fakeFetch(script)
  const ticks: (() => void)[] = []
  const logs: string[] = []
  let legacyReads = 0
  let clock = 1_700_000_000_000
  const uptime = createUptime({
    call: host.call,
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
  return { uptime, host, net, ticks, logs, tick, settle, legacyReads: () => legacyReads }
}

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

test('every check stores its results, which also keeps the worker from being reaped as idle', async () => {
  const { uptime, host, tick, settle } = setup()
  await uptime.start()
  await settle()
  await tick()
  await tick()
  assert.equal(host.writes.filter(key => key === STORAGE_KEYS.lastResults).length, 3)
})

test('the deployment list is seeded once from the mod store and never again', async () => {
  const legacy = { targets: [STAGING], isOff: true }
  const first = setup({ storage: {}, legacy })
  await first.uptime.start()
  assert.deepEqual(first.host.storage.get('targets'), [STAGING])
  assert.equal(first.host.storage.get('isOff'), true)
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

test('an existing list is never overwritten by the seed', async () => {
  const { uptime, host } = setup({ storage: { targets: [PROD] }, legacy: { targets: [STAGING] } })
  await uptime.start()
  assert.deepEqual(host.storage.get('targets'), [PROD])
})

test('turning off persists, stops polling and says how to resume; turning on checks right away', async () => {
  const { uptime, host, net, ticks, tick, settle } = setup()
  await uptime.start()
  await settle()
  const off = await uptime.turnOff()
  assert.equal(host.storage.get('isOff'), true)
  assert.equal(ticks.length, 0)
  assert.deepEqual(off, {
    title: 'uptime off',
    body: 'No checks and no notifications, also after a restart. Run "Uptime: Turn on" to resume.',
  })
  const before = net.requested.length
  await tick(5)
  assert.equal(net.requested.length, before)

  const status = await uptime.showStatus()
  assert.equal(status.title, 'uptime is off')
  assert.match(status.body, /^uptime is off: last known results/)
  assert.match(status.body, /up at last check, 5m ago/)

  const on = await uptime.turnOn()
  assert.equal(host.storage.get('isOff'), false)
  assert.equal(ticks.length, 1)
  assert.equal(net.requested.length, before + 2)
  assert.equal(on.title, 'uptime 2/2 ✓')
})

test('a worker started while off neither checks nor polls', async () => {
  const { uptime, net, ticks, settle } = setup({ storage: { targets: [STAGING], seededFromMod: true, isOff: true } })
  await uptime.start()
  await settle()
  assert.deepEqual(net.requested, [])
  assert.equal(ticks.length, 0)
})

test('Check now joins a check already running instead of probing twice', async () => {
  const { uptime, net, settle } = setup({ script: { [STAGING.url]: ['hang'], [PROD.url]: [OK] } })
  void uptime.start()
  await settle()
  void uptime.checkNow()
  await settle()
  assert.deepEqual(net.requested, [STAGING.url, PROD.url])
})

test('Check now answers with the status line as title and one line per deployment', async () => {
  const { uptime, host, settle } = setup({ script: { [STAGING.url]: [{ status: 503, body: '' }], [PROD.url]: [OK] } })
  await uptime.start()
  await settle()
  const summary = await uptime.checkNow()
  assert.deepEqual(summary, {
    title: 'uptime 1/2 · staging ✗',
    body: '✗ staging  down for just now · 503 · 0 ms\n✓ prod  up for just now · 200 · 0 ms',
  })
  assert.deepEqual(host.notifications.at(-1), summary)
})

test('stopping the worker before start() settles leaves no polling timer behind', async () => {
  const { uptime, ticks, settle } = setup()
  void uptime.start()
  uptime.dispose()
  await settle()
  assert.equal(ticks.length, 0)
})

test('the marker alone prevents a re-seed after the list key is gone', async () => {
  const { uptime, host, legacyReads } = setup({ storage: { seededFromMod: true }, legacy: { targets: [STAGING] } })
  await uptime.start()
  assert.equal(host.storage.get('targets'), undefined)
  assert.equal(legacyReads(), 0)
})
