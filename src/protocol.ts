// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Snapshot } from './present.ts'

export type { Snapshot }

export type AddAnswer = { ok: true; snapshot: Snapshot } | { ok: false; message: string }

export const REQUESTS = {
  snapshot: 'uptime.snapshot',
  check: 'uptime.check',
  add: 'uptime.add',
  remove: 'uptime.remove',
  setOff: 'uptime.setOff',
} as const

export const CHANGED = 'uptime.changed'

declare module 'orca' {
  interface PluginRequests {
    /** The current list and results, without checking. */
    'uptime.snapshot': { output: Snapshot }
    /** Checks every deployment now (joining a check already running). */
    'uptime.check': { output: Snapshot }
    /** Adds a deployment, or replaces the URL of one with that name. */
    'uptime.add': { input: { name: string; url: string }; output: AddAnswer }
    'uptime.remove': { input: { name: string }; output: AddAnswer }
    'uptime.setOff': { input: { isOff: boolean }; output: Snapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each check and each list or on/off change. */
    'uptime.changed': Snapshot
  }
}
