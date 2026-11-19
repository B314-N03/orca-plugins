import assert from 'node:assert/strict'
import { test } from 'node:test'

import { errorText, probe, type FetchFn } from '../src/probe.ts'

const fetchFailed = (cause: object) => new TypeError('fetch failed', { cause })

test('fetch errors read as a short reason, one exact value per shape', () => {
  const cases: [string, unknown, string][] = [
    ['timeout signal', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'timeout after 10s'],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout after 10s'],
    ['refused', fetchFailed({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:59999' }), 'connection refused'],
    ['dns', fetchFailed({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x.invalid' }), 'host not found'],
    ['unknown code', fetchFailed({ code: 'EPROTO' }), 'EPROTO'],
    ['cause message only', fetchFailed({ message: 'bad port' }), 'bad port'],
    ['plain error', new Error('socket hang up\nat stack'), 'socket hang up'],
    ['url in message', new TypeError('Failed to parse URL from https://x.example/h?token=abc'), 'Failed to parse URL from https://x.example/h?…'],
    ['string', 'boom', 'boom'],
    ['null', null, 'request failed'],
  ]
  for (const [label, error, expected] of cases) assert.equal(errorText(error), expected, label)
})

test('a probe records status, latency and the body, capped at 50 kB', async () => {
  let clock = 1000
  const fetchFn: FetchFn = async (_url, init) => {
    assert.equal(init.headers.accept, 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    clock += 42
    return { status: 503, text: async () => 'x'.repeat(60_000) }
  }
  const result = await probe(fetchFn, 'https://x.example/health', () => clock)
  assert.deepEqual({ ...result, body: result.body.length }, { status: 503, ms: 42, body: 50_000, error: null })
})

test('a failed probe has no status and no latency, only a reason', async () => {
  const fetchFn: FetchFn = async () => {
    throw fetchFailed({ code: 'ECONNREFUSED' })
  }
  assert.deepEqual(await probe(fetchFn, 'https://x.example', () => 0), {
    status: null,
    ms: null,
    body: '',
    error: 'connection refused',
  })
})
