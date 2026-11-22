import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'

import { offReport, snapshotOf, statusBarFor, statusReport } from './present.ts'
import type { FetchFn } from './probe.ts'
import { CHANGED, REQUESTS, type AddAnswer } from './protocol.ts'
import { createUptime, POLL_MS, type Change, type Uptime, type UptimeState } from './uptime.ts'

export const COMMANDS = {
  check: 'uptime.check',
  status: 'uptime.status',
  on: 'uptime.on',
  off: 'uptime.off',
} as const

const LEGACY_STORE_DIR = join(homedir(), '.claude', 'plugins', 'store')
const LEGACY_STORE_FILE = /^uptime_inline-[0-9a-f]+\.json$/

// One-time import of the Claude Code mod's deployment list; absent once the mod is gone.
const readLegacyStore = async (): Promise<unknown> => {
  try {
    const file = (await readdir(LEGACY_STORE_DIR)).find(name => LEGACY_STORE_FILE.test(name))
    return file ? JSON.parse(await readFile(join(LEGACY_STORE_DIR, file), 'utf8')) : null
  } catch {
    return null
  }
}

const every = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

// Panel input crosses a process boundary as plain JSON, so its shape is checked, not trusted.
const textField = (input: unknown, key: string) => {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

let running: Uptime | null = null

export default function activate(orca: OrcaWorkerApi) {
  const log = (message: string) => orca.log(message)
  const snapshot = (state: UptimeState) => snapshotOf(state, POLL_MS)
  const answer = (change: Change<UptimeState>): AddAnswer =>
    change.ok ? { ok: true, snapshot: snapshot(change.state) } : change

  const publish = (state: UptimeState) => {
    orca.host.call('statusBar.update', statusBarFor(state)).catch(error => log(`status bar: ${String(error)}`))
    orca.panels.post(CHANGED, snapshot(state))
  }

  const uptime = createUptime({
    storage: {
      get: key => orca.storage.get(key),
      set: (key, value) => orca.storage.set(key, value as JsonValue),
    },
    notify: notification => orca.host.call('notifications.show', notification),
    publish,
    fetch: globalThis.fetch as unknown as FetchFn,
    now: Date.now,
    every,
    readLegacy: readLegacyStore,
    log,
  })

  orca.commands.register(COMMANDS.check, async () => statusReport(await uptime.checkNow()))
  orca.commands.register(COMMANDS.status, async () => statusReport(await uptime.state()))
  orca.commands.register(COMMANDS.on, async () => statusReport(await uptime.turnOn()))
  orca.commands.register(COMMANDS.off, async () => {
    await uptime.turnOff()
    return offReport()
  })

  orca.panels.handle(REQUESTS.snapshot, async () => snapshot(await uptime.state()))
  orca.panels.handle(REQUESTS.check, async () => snapshot(await uptime.checkNow()))
  orca.panels.handle(REQUESTS.add, async input => answer(await uptime.add(textField(input, 'name'), textField(input, 'url'))))
  orca.panels.handle(REQUESTS.remove, async input => answer(await uptime.remove(textField(input, 'name'))))
  orca.panels.handle(REQUESTS.setOff, async input =>
    snapshot((input as { isOff?: unknown })?.isOff === true ? await uptime.turnOff() : await uptime.turnOn()),
  )

  running = uptime
  void uptime.start()
}

export function deactivate() {
  running?.dispose()
  running = null
}
