import type { Probe } from './types.ts'
import { displayUrl } from './url.ts'

export const TIMEOUT_MS = 10_000
const BODY_LIMIT = 50_000

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number
  text(): Promise<string>
}>

const ERROR_NAMES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'DNS lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connection timed out',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
}

type FetchError = { name?: string; message?: string; cause?: { code?: string; message?: string } }

const firstLine = (text: string) =>
  (text.split('\n')[0] || 'request failed').replace(/https?:\/\/\S+/g, url => displayUrl(url)).slice(0, 80)

// Node's fetch wraps the socket error in `cause`; the bare message is just "fetch failed".
export const errorText = (error: unknown): string => {
  const { name, message, cause } = (typeof error === 'object' && error !== null ? error : {}) as FetchError
  if (name === 'TimeoutError' || name === 'AbortError') return `timeout after ${TIMEOUT_MS / 1000}s`
  if (cause?.code) return ERROR_NAMES[cause.code] ?? cause.code
  if (cause?.message) return firstLine(cause.message)
  return firstLine(String(message ?? error ?? 'request failed'))
}

export const probe = async (fetchFn: FetchFn, url: string, clock: () => number): Promise<Probe> => {
  const started = clock()
  try {
    const response = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await response.text()).slice(0, BODY_LIMIT)
    return { status: response.status, ms: Math.round(clock() - started), body, error: null }
  } catch (error) {
    return { status: null, ms: null, body: '', error: errorText(error) }
  }
}
