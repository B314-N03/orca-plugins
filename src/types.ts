export type UptimeTarget = { name: string; url: string }

export type UptimeHealth = 'up' | 'degraded' | 'down' | 'unknown'

export type UptimeResult = {
  name: string
  url: string
  health: UptimeHealth
  status: number | null
  ms: number | null
  failing: string[]
  error: string | null
  consecutiveFails: number
  since: number
  checkedAt: number
  history: (number | null)[]
}

export type Probe = { status: number | null; ms: number | null; body: string; error: string | null }
