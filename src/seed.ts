import { parseTargets } from './logic.ts'
import type { UptimeTarget } from './types.ts'

export type Seed = { targets: UptimeTarget[]; isOff: boolean }

// The Claude Code mod's store file: `{ targets: [{ name, url }], isOff }`.
export const parseLegacyStore = (raw: unknown): Seed | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const { targets, isOff } = raw as { targets?: unknown; isOff?: unknown }
  const parsed = parseTargets(targets)
  if (parsed.length === 0) return null
  return { targets: parsed, isOff: isOff === true }
}

// Seeds once: after the marker is set, an emptied list stays empty.
export const planSeed = (alreadySeeded: unknown, legacy: unknown): Seed | null =>
  alreadySeeded === true ? null : parseLegacyStore(legacy)
