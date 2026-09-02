// Vercel serverless function — Daytona live drop-in.
// POST { image: <base64>, media_type } -> runs the extraction INSIDE a Daytona
// sandbox (stdlib urllib, no pip install) -> returns { job } in jobs.json shape.
//
// Env vars (Vercel project settings): DAYTONA_API_KEY, ANTHROPIC_API_KEY.
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import canonicalMap from './canonicalMap.js'
import { normalizeExtractedTechnicalSkills } from './normalizeSkills.js'
import { uploadScreenshot, removeByPrefix } from './sourceStore.js'
import { runVisionExtraction, VisionSandboxError } from '../api-lib/jd/visionExtraction.js'

const EMPTY_SKILLS_ERROR =
  "No technical skills were extracted. Try a screenshot that includes the role's technical requirements."

// The reusable extractor keeps empty results for evaluation diagnostics. The live dashboard
// cannot use a job that contributes no skill signal, so reject it before route-owned state exists.
function hasLiveTechnicalSkills(extracted) {
  return Array.isArray(extracted?.skills) && extracted.skills.length > 0
}

// Service-role Supabase client, or null if not configured — dedup + persistence both
// degrade gracefully (the user still gets their job in the UI) when it's absent.
function supaClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? createClient(url, key) : null
}

// Look up a previously-parsed screenshot by its file hash. Returns { id, company, title }
// or null. Throws if the query itself fails (caller decides whether to hard-block).
async function findDuplicate(supabase, hash) {
  const { data, error } = await supabase
    .from('job')
    .select('id, company, title')
    .eq('screenshot_hash', hash)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// Persist a parsed job. Throws on a UNIQUE screenshot_hash collision (Postgres 23505)
// so the caller can turn a race into a clean duplicate response.
async function persistJob(supabase, job) {
  const { skills, ...jobRow } = job
  const { error } = await supabase.from('job').insert(jobRow)
  if (error) throw error
  if (skills?.length) {
    await supabase.from('skill').insert(
      skills.map((s) => ({
        job_id: job.id,
        raw_text: s.raw_text,
        canonical: s.canonical,
        requirement: s.requirement,
        alternative_group: s.alternative_group,
      })),
    )
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const daytonaKey = process.env.DAYTONA_API_KEY
  const modelKey = process.env.ANTHROPIC_API_KEY
  if (!daytonaKey || !modelKey) {
    return res.status(500).json({ error: 'missing DAYTONA_API_KEY or ANTHROPIC_API_KEY' })
  }

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'bad JSON body' })
  }
  const image = body?.image
  const mediaType = body?.media_type || 'image/png'
  if (!image) return res.status(400).json({ error: 'no image provided' })

  // Duplicate check BEFORE the expensive Daytona parse: hash the screenshot bytes and
  // block if we've parsed this exact file before. Best-effort — if the lookup errors
  // (e.g. Supabase down), we proceed rather than fail the upload.
  const hash = crypto.createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex')
  const supabase = supaClient()
  if (supabase) {
    try {
      const dup = await findDuplicate(supabase, hash)
      if (dup) return res.status(409).json({ error: 'duplicate', duplicate: dup })
    } catch (e) {
      console.error('duplicate pre-check failed (proceeding to parse):', e)
    }
  }

  try {
    const extracted = await runVisionExtraction({
      image,
      mediaType,
      daytonaApiKey: daytonaKey,
      anthropicApiKey: modelKey,
      normalizeTechnicalSkills: (skills) => normalizeExtractedTechnicalSkills(skills, canonicalMap),
    })
    if (!hasLiveTechnicalSkills(extracted)) {
      return res.status(422).json({ error: EMPTY_SKILLS_ERROR })
    }
    const job = {
      id: 'live-' + Date.now(),
      source: 'screenshot',
      screenshot_hash: hash,
      // Stamp created_at here so it's both persisted AND returned to the client — the
      // freshly dropped-in job then shows the "New" badge immediately, not just after a
      // reload (isNewJob keys off created_at, which the API otherwise wouldn't return).
      created_at: new Date().toISOString(),
      ...extracted,
    }
    // Store the source screenshot BEFORE the insert and the response: the path rides
    // the single row insert (no second write) and the client response (post-res.json
    // work can silently never run on Vercel — same class as the created_at bug).
    // Best-effort: null path = today's behavior, the job still ships.
    job.screenshot_path = supabase
      ? await uploadScreenshot(supabase, Buffer.from(image, 'base64'), job.id, mediaType)
      : null
    if (supabase) {
      try {
        await persistJob(supabase, job) // persist so it survives a refresh; best-effort
      } catch (e) {
        // The row didn't land, so a stored file would be unreachable — remove it and
        // drop the path from the response (orphan rule, storage-blueprint.md).
        if (job.screenshot_path) {
          await removeByPrefix(supabase, 'screenshots', job.id + '.')
          job.screenshot_path = null
        }
        // Race: a concurrent identical upload won the UNIQUE index between our pre-check
        // and this insert. Surface it as the duplicate it is rather than a 500.
        if (e?.code === '23505') {
          try {
            const dup = await findDuplicate(supabase, hash)
            if (dup) return res.status(409).json({ error: 'duplicate', duplicate: dup })
          } catch (e2) {
            console.error('post-collision lookup failed:', e2)
          }
        }
        console.error('persistJob failed', e)
      }
    }
    // Don't leak the internal hash column into the client-side job shape.
    const { screenshot_hash, ...jobForClient } = job
    return res.status(200).json({ job: jobForClient })
  } catch (e) {
    if (e instanceof VisionSandboxError) {
      return res.status(500).json({ error: 'sandbox error', detail: e.detail })
    }
    return res.status(500).json({ error: String(e) })
  }
}
