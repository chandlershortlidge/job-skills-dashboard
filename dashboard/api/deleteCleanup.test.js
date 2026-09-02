// Tests for the storage cleanup contract in storage-blueprint.md — Supabase
// mocked, no network. Locks: row delete also removes the stored file by
// deterministic prefix (even when the path column was null), and a storage
// failure never fails the row delete.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const supa = {
  files: [], // paths present in storage
  removed: [],
  deletedRows: [],
  failList: false,
  reset() {
    this.files = []
    this.removed = []
    this.deletedRows = []
    this.failList = false
  },
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => ({
      delete: () => ({
        eq: async (_col, id) => {
          supa.deletedRows.push({ table, id })
          return { error: null }
        },
      }),
    }),
    storage: {
      from: () => ({
        list: async (folder, opts) =>
          supa.failList
            ? { data: null, error: { message: 'list boom' } }
            : {
                data: supa.files
                  .filter((p) => p.startsWith(folder + '/') && p.slice(folder.length + 1).includes(opts?.search ?? ''))
                  .map((p) => ({ name: p.slice(folder.length + 1) })),
                error: null,
              },
        remove: async (paths) => {
          supa.removed.push(...paths)
          return { data: paths.map((p) => ({ name: p })), error: null }
        },
      }),
    },
  }),
}))

const jobHandler = (await import('./job.js')).default
const cvHandler = (await import('./cv.js')).default

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

describe('DELETE /api/job — screenshot cleanup', () => {
  it('deletes skills + job row, then the stored screenshot by prefix', async () => {
    supa.files = ['screenshots/live-123.png', 'screenshots/live-1234.png']
    const res = mockRes()
    await jobHandler({ method: 'DELETE', query: { id: 'live-123' } }, res)
    expect(res.statusCode).toBe(200)
    expect(supa.deletedRows).toEqual([
      { table: 'skill', id: 'live-123' },
      { table: 'job', id: 'live-123' },
    ])
    // exact-prefix match only — live-1234's file untouched
    expect(supa.removed).toEqual(['screenshots/live-123.png'])
  })

  it('row delete succeeds even when storage listing fails (best-effort)', async () => {
    supa.failList = true
    const res = mockRes()
    await jobHandler({ method: 'DELETE', query: { id: 'live-123' } }, res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('no stored file (legacy null-path row): delete is clean, nothing removed', async () => {
    const res = mockRes()
    await jobHandler({ method: 'DELETE', query: { id: 'job-2' } }, res)
    expect(res.statusCode).toBe(200)
    expect(supa.removed).toEqual([])
  })
})

describe('DELETE /api/cv — PDF cleanup', () => {
  it('deletes the cv row, then the stored PDF by prefix', async () => {
    supa.files = ['cvs/17.pdf', 'cvs/170.pdf']
    const res = mockRes()
    await cvHandler({ method: 'DELETE', query: { id: '17' }, body: null }, res)
    expect(res.statusCode).toBe(200)
    expect(supa.deletedRows).toEqual([{ table: 'cv', id: '17' }])
    expect(supa.removed).toEqual(['cvs/17.pdf'])
  })

  it('removes an orphaned PDF even though pdf_path was never stamped (null-column tolerance)', async () => {
    // The file exists but the row's pdf_path update failed earlier — prefix-based
    // cleanup finds it anyway; nothing here reads the column.
    supa.files = ['cvs/17.pdf']
    const res = mockRes()
    await cvHandler({ method: 'DELETE', query: { id: '17' }, body: null }, res)
    expect(supa.removed).toEqual(['cvs/17.pdf'])
  })
})
