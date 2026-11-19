import { detailText, sparkline } from './logic.ts'
import type { Snapshot } from './present.ts'
import type { UptimeHealth, UptimeResult } from './types.ts'

export type RowTone = 'neutral' | 'success' | 'warning' | 'danger'

export type RowView = {
  key: string
  name: string
  health: UptimeHealth
  icon: string
  tone: RowTone
  since: number | null
  detail: string
  spark: string
  url: string
}

const ICON: Record<UptimeHealth, string> = { up: '✓', degraded: '⚠', down: '✗', unknown: '…' }
const TONE: Record<UptimeHealth, RowTone> = { up: 'success', degraded: 'warning', down: 'danger', unknown: 'neutral' }

export const rowView = (deployment: UptimeResult): RowView => ({
  key: deployment.name,
  name: deployment.name,
  health: deployment.health,
  icon: ICON[deployment.health],
  tone: TONE[deployment.health],
  since: deployment.health === 'unknown' ? null : deployment.since,
  detail: detailText(deployment),
  spark: sparkline(deployment.history ?? []),
  url: deployment.url,
})

export const rowsOf = (snapshot: Snapshot) => snapshot.deployments.map(rowView)

export const footerText = (snapshot: Snapshot) => `every ${Math.round(snapshot.pollMs / 1000)} s`
