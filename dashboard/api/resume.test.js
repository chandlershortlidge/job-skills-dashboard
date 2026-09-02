// Tests for the résumé handler (api/resume.js) with Daytona + Supabase mocked —
// no network, no real LLM call (AGENTS.md: never live). Locks the storage
// contract in storage-blueprint.md: insert-then-upload ordering (cvs/<id>.pdf),
// pdf_path stamped on the row, and every failure path degrading to a served
// profile.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The parsed profile the "model" returns from inside the sandbox.
const PARSED = {
  title: 'AI Engineer',
  years_experience: 4,
  skills: [
    { raw_text: 'Python', canonical: 'Python' },
    { raw_text: 'RAG pipelines', canonical: 'RAG' },
  ],
}

vi.mock('@daytona/sdk', () => ({
  Daytona: class {
    async create() {
      return {
        process: { codeRun: async () => ({ exitCode: 0, result: JSON.stringify(PARSED) }) },
        delete: async () => {},
      }
    }
  },
}))

// Controllable fake Supabase (cv table + Storage).
const supa = {
  nextId: 17,
  updates: [],
  uploads: [],
  inserts: [],
  failInsert: false,
  failUpload: false,
  reset() {
    this.nextId = 17
    this.updates = []
    this.uploads = []
    this.inserts = []
    this.failInsert = false
    this.failUpload = false
  },
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: (row) => {
        supa.inserts.push(row)
        return {
          select: () => ({
            single: async () =>
              supa.failInsert
                ? { data: null, error: { message: 'insert boom' } }
                : { data: { id: supa.nextId }, error: null },
          }),
        }
      },
      update: (patch) => ({
        eq: async (col, val) => {
          supa.updates.push({ patch, col, val })
          return { error: null }
        },
      }),
    }),
    storage: {
      from: () => ({
        upload: async (path) => {
          if (supa.failUpload) return { data: null, error: { message: 'upload boom' } }
          supa.uploads.push(path)
          return { data: { path }, error: null }
        },
      }),
    },
  }),
}))

const handler = (await import('./resume.js')).default

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => ((res.statusCode = code), res)
  res.json = (obj) => ((res.body = obj), res)
  return res
}

const REQ = {
  method: 'POST',
  body: {
    pdf: Buffer.from('fake-pdf-bytes').toString('base64'),
    media_type: 'application/pdf',
    filename: 'My_CV.pdf',
  },
}

beforeEach(() => {
  supa.reset()
  process.env.DAYTONA_API_KEY = 'test-key'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.SUPABASE_URL = 'https://fake.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-secret'
})

describe('POST /api/resume (Daytona + Supabase mocked — source-file storage)', () => {
  it('insert-then-upload: PDF stored at cvs/<id>.pdf and pdf_path stamped on the row', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.cv).toEqual({ id: 17, name: 'My_CV' })
    expect(supa.uploads).toEqual(['cvs/17.pdf'])
    expect(supa.updates).toEqual([{ patch: { pdf_path: 'cvs/17.pdf' }, col: 'id', val: 17 }])
  })

  it('upload failure degrades: profile + cv still returned, no pdf_path update', async () => {
    supa.failUpload = true
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.cv).toEqual({ id: 17, name: 'My_CV' })
    expect(supa.updates).toEqual([])
  })

  it('insert failure: no upload attempted (no id to key the path), profile still served', async () => {
    supa.failInsert = true
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.profile.skills.length).toBeGreaterThan(0)
    expect(res.body.cv).toBe(null)
    expect(supa.uploads).toEqual([])
  })

  it('no Supabase env: profile served, nothing stored', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.cv).toBe(null)
    expect(supa.uploads).toEqual([])
  })

  it('normalizes and persists only extracted skills without synthetic LLM rows', async () => {
    const res = mockRes()
    await handler(REQ, res)
    const canons = res.body.profile.skills.map((s) => s.canonical)
    expect(canons).toEqual(['Python', 'RAG'])
    expect(supa.inserts[0].skills.map((s) => s.canonical)).toEqual(['Python', 'RAG'])
  })
})
