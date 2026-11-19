// Runs under `orca plugin test` (Orca >= 1.4.248), which provides the `orca/*` modules.
import { assert, mockHost, mount, test } from 'orca/testing'

import * as panel from './panel.tsx'
import type { AddAnswer, Snapshot } from './protocol.ts'

const deployment = (name: string, health: 'up' | 'down', url: string) => ({
  name,
  url,
  health,
  status: health === 'up' ? 200 : null,
  ms: health === 'up' ? 120 : null,
  failing: [],
  error: health === 'up' ? null : 'connection refused',
  consecutiveFails: health === 'up' ? 0 : 2,
  since: 1_700_000_000_000,
  checkedAt: 1_700_000_060_000,
  history: health === 'up' ? [120, 130] : [120, null],
})

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  isOff: false,
  pollMs: 60_000,
  checkedAt: 1_700_000_060_000,
  deployments: [deployment('staging', 'down', 'https://staging.example/health'), deployment('prod', 'up', 'https://prod.example/health?…')],
  ...overrides,
})

const mountWith = (requests: Record<string, unknown>) => mount(panel, { host: mockHost({ requests }) })

test('lists every deployment with its state, reason, sparkline and redacted URL', async () => {
  const view = await mountWith({ 'uptime.snapshot': snapshot() })
  assert.deepEqual(view.errors, [])
  assert.ok(view.find({ text: /✗ staging/ }))
  assert.ok(view.find({ text: /connection refused/ }))
  assert.ok(view.find({ text: 'https://prod.example/health?…' }))
  assert.ok(view.find({ label: 'Remove prod' }))
  assert.deepEqual(view.refusals, [])
})

test('an empty list shows the empty state', async () => {
  const view = await mountWith({ 'uptime.snapshot': snapshot({ deployments: [], checkedAt: null }) })
  assert.ok(view.find({ label: 'No deployments yet' }))
  assert.ok(view.find({ text: /not checked yet/ }))
})

test('adding sends the trimmed name and URL, clears the form and shows the new list', async () => {
  const sent: unknown[] = []
  const added = snapshot({ deployments: [deployment('demo', 'up', 'https://demo.example/health')] })
  const view = await mountWith({
    'uptime.snapshot': snapshot(),
    'uptime.add': (input: unknown): AddAnswer => (sent.push(input), { ok: true, snapshot: added }),
  })
  await view.type({ label: 'Name' }, ' demo ')
  await view.type({ label: 'Health URL' }, 'https://demo.example/health')
  await view.press({ type: 'Button', text: 'Add' })
  assert.deepEqual(sent, [{ name: 'demo', url: 'https://demo.example/health' }])
  assert.equal(view.valueOf({ label: 'Name' }), '')
  assert.ok(view.find({ text: /✓ demo/ }))
  assert.equal(view.find({ text: /✗ staging/ }), null)
})

test('a refused add keeps the form and shows the reason', async () => {
  const view = await mountWith({
    'uptime.snapshot': snapshot(),
    'uptime.add': (): AddAnswer => ({ ok: false, message: '"ftp://x/" is not an http(s) URL.' }),
  })
  await view.type({ label: 'Name' }, 'x')
  await view.type({ label: 'Health URL' }, 'ftp://x', { submit: true })
  assert.ok(view.find({ text: '"ftp://x/" is not an http(s) URL.' }))
  assert.equal(view.valueOf({ label: 'Name' }), 'x')
})

test('removing asks the worker by name', async () => {
  const sent: unknown[] = []
  const view = await mountWith({
    'uptime.snapshot': snapshot(),
    'uptime.remove': (input: unknown): AddAnswer => (sent.push(input), { ok: true, snapshot: snapshot({ deployments: [] }) }),
  })
  await view.press({ label: 'Remove staging' })
  assert.deepEqual(sent, [{ name: 'staging' }])
  assert.ok(view.find({ label: 'No deployments yet' }))
})

test('the switch turns checking off, and the panel follows what the worker posts', async () => {
  const sent: unknown[] = []
  const view = await mountWith({
    'uptime.snapshot': snapshot(),
    'uptime.setOff': (input: unknown) => (sent.push(input), snapshot({ isOff: true })),
  })
  await view.toggle({ label: 'Checking' })
  assert.deepEqual(sent, [{ isOff: true }])
  assert.ok(view.find({ label: 'uptime is off' }))
  assert.equal(view.find({ type: 'Button', text: 'Check now' })?.disabled, true)

  await view.post('uptime.changed', snapshot())
  assert.equal(view.find({ label: 'uptime is off' }), null)
})
