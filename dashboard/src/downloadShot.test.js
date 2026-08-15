// Tests for the save-a-copy URL fetch (src/downloadShot.js) with fetch injected
// — no network. Locks the &download=1 flag (without it the URL opens instead of
// saving) and the non-throwing-to-the-caller error contract.
import { describe, it, expect } from 'vitest'
import { fetchScreenshotDownloadUrl } from './downloadShot'

function okFetch(url = 'https://signed.example/screenshots/live-1.png?download=live-1.png') {
  const calls = []
  const impl = async (u) => {
    calls.push(u)
    return { ok: true, status: 200, json: async () => ({ url }) }
  }
  impl.calls = calls
  return impl
}

describe('fetchScreenshotDownloadUrl', () => {
  it('requests the screenshot kind with download=1 and an encoded id', async () => {
    const f = okFetch()
    await fetchScreenshotDownloadUrl('live 1&x', f)
    expect(f.calls[0]).toBe('/api/file?kind=screenshot&id=live%201%26x&download=1')
  })

  it('returns the signed url', async () => {
    const url = 'https://signed.example/screenshots/live-1.png?download=live-1.png'
    expect(await fetchScreenshotDownloadUrl('live-1', okFetch(url))).toBe(url)
  })

  it('throws the server error message on a 4xx', async () => {
    const f = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no stored file for this id' }),
    })
    await expect(fetchScreenshotDownloadUrl('job-2', f)).rejects.toThrow(
      'no stored file for this id',
    )
  })

  it('throws on a 200 with no url (never hands the caller undefined)', async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => ({}) })
    await expect(fetchScreenshotDownloadUrl('job-2', f)).rejects.toThrow('HTTP 200')
  })

  it('throws on a non-JSON body instead of blowing up on the parse', async () => {
    const f = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })
    await expect(fetchScreenshotDownloadUrl('job-2', f)).rejects.toThrow('HTTP 500')
  })
})
