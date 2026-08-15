// Tests for the signed-URL route (api/file.js) with Supabase mocked — no
// network (AGENTS.md: never live). Locks the access contract from
// storage-blueprint.md: kind allowlist is screenshot-ONLY in v1 (D1 — cv must
// 400), GET only, path comes from the DB row never the query string, and every
// missing-thing case is a clean 4xx.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const supa = {
  rows: {}, // id -> { screenshot_path }
  signable: true,
  lastOptions: undefined, // options the route passed to createSignedUrl
  reset() {
    this.rows = {}
    this.signable = true
    this.lastOptions = undefined
  },
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_col, id) => ({
          maybeSingle: async () => ({ data: supa.rows[id] ?? null, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (path, ttl, options) => {
          supa.lastOptions = options
          const dl = options?.download ? `&download=${options.download}` : ''
          return supa.signable
            ? { data: { signedUrl: `https://signed.example/${path}?t=${ttl}${dl}` }, error: null }
            : { data: null, error: { message: 'Object not found' } }
        },
      }),
    },
  }),
}))

const handler = (await import('./file.js')).default

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => ((res.statusCode = code), res)
  res.json = (obj) => ((res.body = obj), res)
  return res
}

beforeEach(() => {
  supa.reset()
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-secret'
})

describe('GET /api/file (Supabase mocked)', () => {
  it('returns a signed URL for a job with a stored screenshot', async () => {
    supa.rows['live-123'] = { screenshot_path: 'screenshots/live-123.png' }
    const res = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot', id: 'live-123' } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.url).toContain('screenshots/live-123.png')
    expect(res.body.url).toContain('t=3600')
  })

  it('plain view URLs carry no download option', async () => {
    supa.rows['live-123'] = { screenshot_path: 'screenshots/live-123.png' }
    const res = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot', id: 'live-123' } }, res)
    expect(res.statusCode).toBe(200)
    expect(supa.lastOptions).toBeUndefined()
  })

  it('download=1 asks for an attachment named after the stored path, not the query', async () => {
    supa.rows['live-123'] = { screenshot_path: 'screenshots/live-123.png' }
    const res = mockRes()
    await handler(
      { method: 'GET', query: { kind: 'screenshot', id: 'live-123', download: '1' } },
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(supa.lastOptions).toEqual({ download: 'live-123.png' })
    expect(res.body.url).toContain('t=3600') // same TTL as the view URL
  })

  it('ignores a non-"1" download value (no accidental attachment)', async () => {
    supa.rows['live-123'] = { screenshot_path: 'screenshots/live-123.png' }
    const res = mockRes()
    await handler(
      { method: 'GET', query: { kind: 'screenshot', id: 'live-123', download: 'evil.sh' } },
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(supa.lastOptions).toBeUndefined()
  })

  it('rejects kind=cv with 400 — CV retrieval is cut from v1 (D1)', async () => {
    const res = mockRes()
    await handler({ method: 'GET', query: { kind: 'cv', id: '17' } }, res)
    expect(res.statusCode).toBe(400)
  })

  it('rejects unknown kinds and missing id with 400', async () => {
    const r1 = mockRes()
    await handler({ method: 'GET', query: { kind: 'anything', id: 'x' } }, r1)
    expect(r1.statusCode).toBe(400)
    const r2 = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot' } }, r2)
    expect(r2.statusCode).toBe(400)
  })

  it('404s for an unknown id and for a row with a null path (legacy jobs)', async () => {
    const r1 = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot', id: 'job-999' } }, r1)
    expect(r1.statusCode).toBe(404)
    supa.rows['job-2'] = { screenshot_path: null }
    const r2 = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot', id: 'job-2' } }, r2)
    expect(r2.statusCode).toBe(404)
  })

  it('404s when the row has a path but the object is gone from storage', async () => {
    supa.rows['live-123'] = { screenshot_path: 'screenshots/live-123.png' }
    supa.signable = false
    const res = mockRes()
    await handler({ method: 'GET', query: { kind: 'screenshot', id: 'live-123' } }, res)
    expect(res.statusCode).toBe(404)
  })

  it('GET only', async () => {
    const res = mockRes()
    await handler({ method: 'POST', query: { kind: 'screenshot', id: 'x' } }, res)
    expect(res.statusCode).toBe(405)
  })
})
