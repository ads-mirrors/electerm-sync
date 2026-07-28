import { expect, test, describe, vi } from 'vitest'
import axios from 'axios'
import { HTTPError, electermSync } from '../src/electerm-sync'

/**
 * These tests verify that the library handles axios configs containing
 * non-serializable objects (such as httpsAgent / SocksProxyAgent) without
 * throwing "Converting circular structure to JSON".
 *
 * They run entirely offline — no real API tokens or network access required.
 */

describe('sanitizeConfig / circular reference handling', () => {
  test('HTTPError can be constructed with a config that has circular httpsAgent', () => {
    // Simulate a SocksProxyAgent-like object with a circular reference
    const fakeAgent: any = { type: 'socks' }
    fakeAgent.self = fakeAgent // circular reference

    const config = {
      url: 'https://api.github.com/gists',
      method: 'GET',
      headers: { Authorization: 'token abc' },
      httpsAgent: fakeAgent // this is what causes the original crash
    }

    // Before the fix, this constructor would throw:
    //   "Converting circular structure to JSON"
    const err = new HTTPError(401, 'Unauthorized', { message: 'Bad credentials' }, config)

    // The error message should be a valid string, not a thrown exception
    expect(err.message).toContain('status: 401')
    expect(err.message).toContain('Unauthorized')
    expect(err.message).toContain('Bad credentials')
    expect(err.message).toContain('config:')

    // The stored config should have httpsAgent stripped
    expect((err.config as any).httpsAgent).toBeUndefined()
    // But other keys should be preserved
    expect(err.config.url).toBe('https://api.github.com/gists')
    expect(err.config.method).toBe('GET')
  })

  test('HTTPError with clean config still preserves all keys', () => {
    const config = {
      url: 'https://api.github.com/gists',
      method: 'GET',
      headers: { Authorization: 'token abc' }
    }

    const err = new HTTPError(200, 'OK', {}, config)

    expect(err.config.url).toBe('https://api.github.com/gists')
    expect(err.config.method).toBe('GET')
    expect(err.config.headers).toEqual({ Authorization: 'token abc' })
  })

  test('HTTPError with null/undefined config does not throw', () => {
    expect(() => new HTTPError(500, 'Server Error', {}, null as any)).not.toThrow()
    expect(() => new HTTPError(500, 'Server Error', {}, undefined as any)).not.toThrow()
  })

  test('HTTPError config is JSON-serializable after sanitization', () => {
    const fakeAgent: any = { type: 'socks' }
    fakeAgent.self = fakeAgent

    const config = {
      url: 'https://api.github.com/gists',
      method: 'GET',
      httpsAgent: fakeAgent,
      httpAgent: fakeAgent
    }

    const err = new HTTPError(403, 'Forbidden', { message: 'Forbidden' }, config)

    // This should not throw
    expect(() => JSON.stringify(err.config)).not.toThrow()
    expect(() => JSON.stringify(err.message)).not.toThrow()
  })

  test('request() throws HTTPError without circular reference when axios returns HTTP error with httpsAgent', async () => {
    // Simulate a SocksProxyAgent-like object with a circular reference
    const fakeAgent: any = { type: 'socks' }
    fakeAgent.self = fakeAgent

    // Create a plain axios instance — we mock request() directly so
    // the circular agent never goes through axios.create() config merge
    const axiosInstance = axios.create()

    // Mock axios.request to simulate a 401 HTTP error response
    // The error will have response.config containing httpsAgent
    vi.spyOn(axiosInstance, 'request').mockRejectedValue({
      response: {
        status: 401,
        statusText: 'Unauthorized',
        data: { message: 'Bad credentials' },
        config: {
          url: 'https://api.github.com/gists',
          method: 'GET',
          httpsAgent: fakeAgent
        }
      },
      config: {
        url: 'https://api.github.com/gists',
        method: 'GET',
        httpsAgent: fakeAgent
      }
    })

    // Before the fix, this would throw "Converting circular structure to JSON"
    // inside the HTTPError constructor, masking the real 401 error
    await expect(
      electermSync(axiosInstance, 'github', 'test', [], 'fake-token')
    ).rejects.toThrow(HTTPError)

    try {
      await electermSync(axiosInstance, 'github', 'test', [], 'fake-token')
    } catch (e: any) {
      // The error should be an HTTPError with sanitized config
      expect(e).toBeInstanceOf(HTTPError)
      expect(e.status).toBe(401)
      expect(e.statusText).toBe('Unauthorized')
      // httpsAgent should be stripped from the stored config
      expect((e.config as any).httpsAgent).toBeUndefined()
      // The error message (which includes JSON.stringify of config) should work
      expect(e.message).toContain('status: 401')
      // Should be JSON-serializable
      expect(() => JSON.stringify(e.message)).not.toThrow()
      expect(() => JSON.stringify(e.config)).not.toThrow()
    }

    vi.restoreAllMocks()
  })

  test('request() sanitizes non-HTTP errors (no response) with config containing httpsAgent', async () => {
    const fakeAgent: any = { type: 'socks' }
    fakeAgent.self = fakeAgent

    // Create a plain axios instance — we mock request() directly
    const axiosInstance = axios.create()

    // Simulate a network error (no response) — the error itself has a config
    const networkError: any = new Error('connect ECONNREFUSED')
    networkError.config = {
      url: 'https://api.github.com/gists',
      method: 'GET',
      httpsAgent: fakeAgent
    }

    vi.spyOn(axiosInstance, 'request').mockRejectedValue(networkError)

    // Before the fix, the caller might try to JSON.stringify the error's config
    // and hit the circular reference
    await expect(
      electermSync(axiosInstance, 'github', 'test', [], 'fake-token')
    ).rejects.toThrow('connect ECONNREFUSED')

    try {
      await electermSync(axiosInstance, 'github', 'test', [], 'fake-token')
    } catch (e: any) {
      // The original error is re-thrown, but its config should be sanitized
      expect(e.message).toBe('connect ECONNREFUSED')
      expect((e.config as any).httpsAgent).toBeUndefined()
      expect((e.config as any).url).toBe('https://api.github.com/gists')
      // Should be JSON-serializable now
      expect(() => JSON.stringify(e.config)).not.toThrow()
    }

    vi.restoreAllMocks()
  })

  test('whitelist approach: keeps primitives + core objects (headers/data), strips everything else', () => {
    // Simulate a config with a mix of safe and dangerous values.
    // Only string/number/boolean and the core object keys (headers, data)
    // should survive; all other objects are dropped.
    const circular: any = { name: 'customAgent' }
    circular.self = circular

    const config = {
      // Primitives — kept
      url: 'https://api.github.com/gists',
      method: 'POST',
      timeout: 5000,
      // Core object keys — kept (round-tripped through JSON)
      headers: { Authorization: 'token abc', 'Content-Type': 'application/json' },
      data: { description: 'my gist', files: { 'a.txt': { content: 'hello' } } },
      // Non-core objects — dropped, even if safe
      metadata: { requestId: 'req-123', retryCount: 3 },
      // Non-core object with circular ref — dropped
      customTransport: circular
    }

    const err = new HTTPError(500, 'Internal Server Error', { message: 'boom' }, config)

    // Primitives are preserved
    expect(err.config.url).toBe('https://api.github.com/gists')
    expect(err.config.method).toBe('POST')
    expect((err.config as any).timeout).toBe(5000)

    // Core object keys are preserved (round-tripped through JSON)
    expect(err.config.headers).toEqual({ Authorization: 'token abc', 'Content-Type': 'application/json' })
    expect(err.config.data).toEqual({ description: 'my gist', files: { 'a.txt': { content: 'hello' } } })

    // Non-core objects are stripped — even safe ones
    expect((err.config as any).metadata).toBeUndefined()
    expect((err.config as any).customTransport).toBeUndefined()

    // Everything is JSON-serializable
    expect(() => JSON.stringify(err.config)).not.toThrow()
    expect(() => JSON.stringify(err.message)).not.toThrow()
  })

  test('whitelist approach: core object key with circular ref is gracefully skipped', () => {
    // Even headers/data, if they somehow contain a circular reference,
    // should be skipped rather than crashing the constructor.
    const circularHeaders: any = { Authorization: 'token abc' }
    circularHeaders.self = circularHeaders

    const config = {
      url: 'https://api.github.com/gists',
      method: 'GET',
      headers: circularHeaders,
      data: circularHeaders
    }

    const err = new HTTPError(403, 'Forbidden', { message: 'nope' }, config)

    // Primitives preserved
    expect(err.config.url).toBe('https://api.github.com/gists')
    expect(err.config.method).toBe('GET')

    // Circular core objects are skipped (not stored, no crash)
    expect(err.config.headers).toBeUndefined()
    expect(err.config.data).toBeUndefined()

    // Still fully JSON-serializable
    expect(() => JSON.stringify(err.config)).not.toThrow()
    expect(() => JSON.stringify(err.message)).not.toThrow()
  })

  test('full error round-trip: error can be JSON.stringify-ed by downstream consumers', async () => {
    const fakeAgent: any = { type: 'socks' }
    fakeAgent.self = fakeAgent

    const axiosInstance = axios.create()

    vi.spyOn(axiosInstance, 'request').mockRejectedValue({
      response: {
        status: 404,
        statusText: 'Not Found',
        data: { message: 'Not Found' },
        config: {
          url: 'https://api.github.com/gists/nonexistent',
          method: 'GET',
          httpsAgent: fakeAgent,
          proxy: fakeAgent
        }
      }
    })

    try {
      await electermSync(axiosInstance, 'github', 'getOne', ['nonexistent'], 'fake-token')
    } catch (e: any) {
      // The electerm server does: { error: { message: 'Sync data error: ' + e.message } }
      // then JSON.stringify the whole thing over WebSocket.
      // This must not throw.
      const wsPayload = {
        error: {
          message: 'Sync data error: ' + e.message
        }
      }
      expect(() => JSON.stringify(wsPayload)).not.toThrow()
      expect(wsPayload.error.message).toContain('status: 404')
    }

    vi.restoreAllMocks()
  })
})
