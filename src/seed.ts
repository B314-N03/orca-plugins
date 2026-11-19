import { parseTargets, validateTarget } from './logic.ts'
import type { UptimeTarget } from './types.ts'

export type Seed = { targets: UptimeTarget[] }

// The Claude Code mod's store file: `{ targets: [{ name, url }], isOff }`. Only the list carries
// over; the plugin starts on, whatever the mod's switch was.
export const parseLegacyStore = (raw: unknown): Seed | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const { targets } = raw as { targets?: unknown }
  const valid = parseTargets(targets).filter(target => validateTarget(target.name, target.url).ok)
  if (valid.length === 0) return null
  return { targets: valid }
}

// Seeds once: after the marker is set, an emptied list stays empty.
export const planSeed = (alreadySeeded: unknown, legacy: unknown): Seed | null =>
  alreadySeeded === true ? null : parseLegacyStore(legacy)
