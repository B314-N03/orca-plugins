import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { FetchFn } from './probe.ts'
import { createUptime, type HostCall, type Uptime } from './uptime.ts'

export const COMMANDS = {
  check: 'uptime.check',
  status: 'uptime.status',
  on: 'uptime.on',
  off: 'uptime.off',
} as const

export type OrcaWorkerApi = {
  commands: { register(commandId: string, handler: (args: unknown) => unknown): void }
  host: { call: HostCall }
  log(message: string): void
}

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

let running: Uptime | null = null

export default function activate(orca: OrcaWorkerApi) {
  const uptime = createUptime({
    call: (method, params) => orca.host.call(method, params),
    fetch: globalThis.fetch as unknown as FetchFn,
    now: Date.now,
    every,
    readLegacy: readLegacyStore,
    log: message => orca.log(message),
  })
  orca.commands.register(COMMANDS.check, () => uptime.checkNow())
  orca.commands.register(COMMANDS.status, () => uptime.showStatus())
  orca.commands.register(COMMANDS.on, () => uptime.turnOn())
  orca.commands.register(COMMANDS.off, () => uptime.turnOff())
  running = uptime
  void uptime.start()
}

export function deactivate() {
  running?.dispose()
  running = null
}
