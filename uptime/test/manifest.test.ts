import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { OrcaWorkerApi } from 'orca/worker'

import { CHANGED, REQUESTS } from '../src/protocol.ts'
import activate, { COMMANDS, deactivate } from '../src/worker.ts'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json', root), 'utf8'))

// Rules from Orca's manifest format 2 reference (docs/reference/plugin-manifest.md at v1.4.263);
// `orca plugin validate` is the authority once the updated app is installed.
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const TOP_LEVEL = ['$schema', 'manifestVersion', 'execution', 'id', 'name', 'version', 'license', 'description', 'engines', 'pluginApi', 'main', 'contributes', 'capabilities']

test('the manifest is format 2, trusted-worker, and needs an Orca with status bar items', () => {
  assert.deepEqual(Object.keys(manifest), TOP_LEVEL)
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.execution, 'trusted-worker')
  assert.match(manifest.id, ID)
  assert.ok(!manifest.id.startsWith('orca-'), 'orca- ids are reserved')
  assert.equal(manifest.publisher, undefined, 'a local folder gets the publisher "local"')
  assert.equal(manifest.engines.orca, '>=1.4.248')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.license, 'MIT')
  for (const file of [manifest.main, ...manifest.contributes.panels.map((panel: { entry: string }) => panel.entry)]) {
    assert.ok(existsSync(new URL(file, root)), `${file} exists`)
  }
  assert.deepEqual(Object.keys(manifest.contributes).sort(), ['commands', 'panels', 'statusBarItems'])
})

test('it asks only for notifications and its own storage', () => {
  assert.deepEqual(manifest.capabilities, [{ kind: 'notifications:show' }, { kind: 'storage:own' }])
})

test("the status bar item runs one of the plugin's own commands", () => {
  const declared = manifest.contributes.commands.map((command: { id: string }) => command.id)
  for (const command of manifest.contributes.commands) assert.match(command.id, COMMAND_ID)
  for (const item of manifest.contributes.statusBarItems) assert.ok(declared.includes(item.command), item.command)
  assert.equal(manifest.contributes.panels[0].ui, 'components')
})

// A stand-in for the `orca` object the worker gets; only records what activate wires up.
const recordingOrca = () => {
  const commands: string[] = []
  const handlers: string[] = []
  const orca = {
    commands: { register: (id: string) => (commands.push(id), { dispose() {} }) },
    panels: { handle: (name: string) => (handlers.push(name), { dispose() {} }), post: () => {} },
    storage: { get: async () => true, set: async () => {} },
    host: { call: async () => ({ ok: true }), has: () => true },
    log: () => {},
  }
  return { orca: orca as unknown as OrcaWorkerApi, commands, handlers }
}

test('the worker registers exactly the declared commands and every panel request', () => {
  const { orca, commands, handlers } = recordingOrca()
  activate(orca)
  deactivate()
  const declared = manifest.contributes.commands.map((command: { id: string }) => command.id)
  assert.deepEqual([...commands].sort(), [...declared].sort())
  assert.deepEqual([...Object.values(COMMANDS)].sort(), [...declared].sort())
  assert.deepEqual([...handlers].sort(), Object.values(REQUESTS).sort())
  assert.equal(CHANGED, 'uptime.changed')
})
