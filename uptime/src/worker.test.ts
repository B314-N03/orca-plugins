// Runs under `orca plugin test` (Orca >= 1.4.248): the real worker on Orca's mock host.
import type { JsonValue } from 'orca'
import { assert, mockHost, mountWorker, test } from 'orca/testing'

import * as worker from './worker.ts'

// seededFromMod keeps the test away from the real mod store; port 1 fails fast without network.
const UNREACHABLE = 'http://127.0.0.1:1/health'

const start = async (storage: Record<string, JsonValue> = {}) => {
  const host = mockHost({ storage: { seededFromMod: true, targets: [], ...storage } })
  const running = await mountWorker(worker, { host })
  await new Promise(resolve => setTimeout(resolve, 10))
  return running
}

test('activating publishes the status bar item without asking for anything undeclared', async () => {
  const running = await start()
  try {
    const updates = running.host.callsOf('statusBar.update') as { id: string; text: string; visible: boolean }[]
    assert.ok(updates.length > 0)
    assert.equal(updates.at(-1)?.text, 'uptime: no deployments')
    assert.equal(updates.at(-1)?.visible, true)
    assert.deepEqual(running.refusals, [])
  } finally {
    await running.deactivate()
  }
})

test('the panel can add and remove a deployment, and every change is posted', async () => {
  const running = await start()
  try {
    const refused = await running.request('uptime.add', { name: 'bad name', url: UNREACHABLE })
    assert.deepEqual(refused, { ok: false, message: 'Name "bad name": letters, digits, - and _ only.' })

    const added = await running.request('uptime.add', { name: 'local', url: UNREACHABLE })
    assert.ok(added.ok)
    assert.deepEqual(running.host.data().storage.targets, [{ name: 'local', url: UNREACHABLE }])
    assert.ok(running.posts.some(post => post.event === 'uptime.changed'))

    const removed = await running.request('uptime.remove', { name: 'local' })
    assert.ok(removed.ok && removed.snapshot.deployments.length === 0)
    assert.deepEqual(running.refusals, [])
  } finally {
    await running.deactivate()
  }
})

test('Turn off persists, hides the status bar item and answers with how to resume', async () => {
  const running = await start()
  try {
    const answer = await running.command('uptime.off')
    assert.match(String(answer), /^uptime off\. .*Run "Uptime: Turn on" to resume\.$/)
    assert.equal(running.host.data().storage.isOff, true)
    const updates = running.host.callsOf('statusBar.update') as { visible: boolean }[]
    assert.equal(updates.at(-1)?.visible, false)
  } finally {
    await running.deactivate()
  }
})

test('Show status answers with the list and never prints credentials from a URL', async () => {
  const running = await start({ targets: [{ name: 'secret', url: 'https://user:pw@secret.example/health?token=abc' }], isOff: true })
  try {
    const answer = String(await running.command('uptime.status'))
    assert.match(answer, /secret/)
    assert.ok(!/user:pw|token=abc/.test(answer), answer)
  } finally {
    await running.deactivate()
  }
})
