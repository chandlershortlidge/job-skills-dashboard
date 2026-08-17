// Tests for the live drop-in handler (api/extract.js) with the Daytona sandbox mocked —
// no network, no real LLM call (AGENTS.md: never live). Locks the response contract the
// front-end depends on: created_at stamped (drives the "New" badge immediately, no reload),
// live- id, screenshot_hash stripped, skills normalized.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The parsed job the "model" returns from inside the sandbox.
const PARSED = {
  company: 'Acme AI',
  title: 'AI Engineer',
  seniority: 'Mid',
  seniority_signal: '2-5 years',
  seniority_basis: 'inferred',
  summary: 'Builds LLM features.',
  skills: [
    { raw_text: 'Python or Java', canonical: 'Python', requirement: 'required', alternative_group: 'alt-1' },
    { raw_text: 'Python or Java', canonical: 'Java', requirement: 'required', alternative_group: 'alt-1' },
    { raw_text: 'large language models', canonical: 'large language models', requirement: 'required', alternative_group: null },
  ],
  non_skill_mentions: [{ raw_text: 'Degree in computer science', category: 'education', requirement: 'required' }],
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

// Controllable fake Supabase (DB + Storage) for the persistence/storage tests.
// The no-Supabase tests below never reach it (env deleted → supaClient() is null).
const supa = {
  insertedJobs: [],
  insertedSkills: [],
  uploads: [],
  removed: [],
  failUpload: false,
  insertError: null,
  reset() {
    this.insertedJobs = []
    this.insertedSkills = []
    this.uploads = []
    this.removed = []
    this.failUpload = false
    this.insertError = null
  },
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table) => ({
      // findDuplicate chain — always "no existing row" in these tests
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      insert: async (rows) => {
        if (table === 'job') {
          if (supa.insertError) return { error: supa.insertError }
          supa.insertedJobs.push(rows)
        }
        if (table === 'skill') supa.insertedSkills.push(...rows)
        return { error: null }
      },
    }),
    storage: {
      from: () => ({
        upload: async (path) => {
          if (supa.failUpload) return { data: null, error: { message: 'upload boom' } }
          supa.uploads.push(path)
          return { data: { path }, error: null }
        },
        list: async (folder, opts) => ({
          data: supa.uploads
            .filter((p) => p.startsWith(folder + '/') && p.slice(folder.length + 1).includes(opts?.search ?? ''))
            .map((p) => ({ name: p.slice(folder.length + 1) })),
          error: null,
        }),
        remove: async (paths) => {
          supa.removed.push(...paths)
          return { data: paths.map((p) => ({ name: p })), error: null }
        },
      }),
    },
  }),
}))

const handler = (await import('./extract.js')).default

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => ((res.statusCode = code), res)
  res.json = (obj) => ((res.body = obj), res)
  return res
}

const REQ = {
  method: 'POST',
  body: { image: Buffer.from('fake-png-bytes').toString('base64'), media_type: 'image/png' },
}

beforeEach(() => {
  process.env.DAYTONA_API_KEY = 'test-key'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  // No Supabase env -> dedup + persistence degrade gracefully; handler must still 200.
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

describe('POST /api/extract (Daytona mocked, no Supabase)', () => {
  it('returns the job with a fresh created_at ISO timestamp', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    const { job } = res.body
    expect(typeof job.created_at).toBe('string')
    const age = Date.now() - new Date(job.created_at).getTime()
    expect(age).toBeGreaterThanOrEqual(0)
    expect(age).toBeLessThan(10_000) // stamped now, not echoed from anywhere stale
  })

  it('model output cannot override the stamp or internals', async () => {
    // If the schema ever grew created_at/id, the spread order would let the model win —
    // this pins today's contract: our values are the ones the client sees.
    const res = mockRes()
    await handler(REQ, res)
    const { job } = res.body
    expect(job.id.startsWith('live-')).toBe(true)
    expect(job.source).toBe('screenshot')
    expect(job).not.toHaveProperty('screenshot_hash') // internal column, never sent to client
  })

  it('normalizes skills via the shared map (LLM variant collapses)', async () => {
    const res = mockRes()
    await handler(REQ, res)
    const canons = res.body.job.skills.map((s) => s.canonical)
    expect(canons).toContain('Python')
    expect(canons).toContain('LLMs') // "large language models" -> LLMs
  })

  it('returns the extraction audit and preserves alternative groups', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(res.body.job.non_skill_mentions).toEqual(PARSED.non_skill_mentions)
    expect(res.body.job.skills.filter((s) => s.alternative_group === 'alt-1').map((s) => s.canonical))
      .toEqual(['Python', 'Java'])
  })

  it('rejects non-POST and missing image', async () => {
    const r1 = mockRes()
    await handler({ method: 'GET' }, r1)
    expect(r1.statusCode).toBe(405)
    const r2 = mockRes()
    await handler({ method: 'POST', body: {} }, r2)
    expect(r2.statusCode).toBe(400)
  })

  it('screenshot_path is null when Supabase is absent (no storage to write to)', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(res.body.job.screenshot_path).toBe(null)
  })
})

describe('POST /api/extract (Daytona + Supabase mocked — source-file storage)', () => {
  beforeEach(() => {
    supa.reset()
    process.env.SUPABASE_URL = 'https://fake.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-secret'
  })

  it('uploads before insert: the path rides the row insert AND the response', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    const { job } = res.body
    expect(job.screenshot_path).toMatch(/^screenshots\/live-\d+\.png$/)
    expect(supa.uploads).toEqual([job.screenshot_path])
    // single insert carries the path — no second write
    expect(supa.insertedJobs).toHaveLength(1)
    expect(supa.insertedJobs[0].screenshot_path).toBe(job.screenshot_path)
  })

  it('persists the non-skill audit on the job and alternative group on each skill', async () => {
    const res = mockRes()
    await handler(REQ, res)
    expect(supa.insertedJobs[0].non_skill_mentions).toEqual(PARSED.non_skill_mentions)
    expect(supa.insertedSkills.filter((s) => s.alternative_group === 'alt-1').map((s) => s.canonical))
      .toEqual(['Python', 'Java'])
  })

  it('upload failure degrades: job persists and returns with a null path', async () => {
    supa.failUpload = true
    const res = mockRes()
    await handler(REQ, res)
    expect(res.statusCode).toBe(200)
    expect(res.body.job.screenshot_path).toBe(null)
    expect(supa.insertedJobs[0].screenshot_path).toBe(null)
  })

  it('insert failure after a successful upload removes the orphaned file (blueprint orphan rule)', async () => {
    supa.insertError = { code: '23505' }
    const res = mockRes()
    await handler(REQ, res)
    expect(supa.uploads).toHaveLength(1) // the upload did happen...
    expect(supa.removed).toEqual(supa.uploads) // ...and was cleaned up
    expect(res.body.job?.screenshot_path ?? null).toBe(null) // path never reaches the client
  })

  it('disallowed media type: no upload attempted, job still ships', async () => {
    const res = mockRes()
    await handler({ ...REQ, body: { ...REQ.body, media_type: 'image/svg+xml' } }, res)
    expect(res.statusCode).toBe(200)
    expect(supa.uploads).toEqual([])
    expect(res.body.job.screenshot_path).toBe(null)
  })

  it('response leaks no secrets: no service key, no bucket URL, no signed URL (D3)', async () => {
    const res = mockRes()
    await handler(REQ, res)
    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain('service-role-test-secret')
    expect(wire).not.toContain('supabase.co')
    expect(wire).not.toContain('signedUrl')
    expect(wire).not.toContain('token=')
  })
})
