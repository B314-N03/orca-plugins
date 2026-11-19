import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import activate, { COMMANDS, deactivate } from '../src/worker.ts'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json', root), 'utf8'))

// Rules from Orca 1.4.215's manifest v1 schema (src/shared/plugins/plugin-manifest.ts at tag v1.4.215).
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const CAPABILITIES = ['workspace:read', 'terminal:send', 'notifications:show', 'storage', 'secrets', 'events:subscribe', 'settings:own']

test('the manifest satisfies the installed Orca v1 schema', () => {
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.pluginApi, 1)
  assert.match(manifest.id, ID)
  assert.match(manifest.publisher, ID)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.match(manifest.engines.orca, /^>=\d+\.\d+\.\d+$/)
  assert.ok(existsSync(new URL(manifest.main, root)), 'main exists')
  for (const command of manifest.contributes.commands) assert.match(command.id, COMMAND_ID)
  for (const capability of manifest.capabilities) assert.ok(CAPABILITIES.includes(capability.kind), capability.kind)
  assert.deepEqual(Object.keys(manifest.contributes).sort(), ['commands'])
})

test('it asks only for notifications and its own storage', () => {
  assert.deepEqual(manifest.capabilities, [{ kind: 'notifications:show' }, { kind: 'storage' }])
})

// Orca deactivates a worker that registers a command its manifest does not declare.
test('the worker registers exactly the commands the manifest declares', () => {
  const registered: string[] = []
  activate({
    commands: { register: id => void registered.push(id) },
    host: { call: async () => ({ value: true }) },
    log: () => {},
  })
  deactivate()
  const declared = manifest.contributes.commands.map((command: { id: string }) => command.id)
  assert.deepEqual(registered.sort(), [...declared].sort())
  assert.deepEqual(Object.values(COMMANDS).sort(), [...declared].sort())
})
