// Vercel serverless function — Daytona live drop-in.
// POST { image: <base64>, media_type } -> runs the extraction INSIDE a Daytona
// sandbox (stdlib urllib, no pip install) -> returns { job } in jobs.json shape.
//
// Env vars (Vercel project settings): DAYTONA_API_KEY, ANTHROPIC_API_KEY.
import crypto from 'node:crypto'
import { Daytona } from '@daytona/sdk'
import { createClient } from '@supabase/supabase-js'
import canonicalMap from './canonicalMap.js'
import { normalizeSkills } from './normalizeSkills.js'
import { uploadScreenshot, removeByPrefix } from './sourceStore.js'

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

const MODEL = 'claude-sonnet-4-6'

const USER_TEXT = 'Extract the job posting from this screenshot.'

// Plain JSON schema (no $ref) for the tool the model must call.
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    company: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    seniority: { type: ['string', 'null'], enum: ['Junior', 'Mid', 'Senior', null] },
    seniority_signal: { type: ['string', 'null'] },
    seniority_basis: { type: ['string', 'null'], enum: ['stated', 'inferred', null] },
    summary: { type: ['string', 'null'] },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw_text: { type: 'string' },
          canonical: { type: 'string' },
          requirement: { type: 'string', enum: ['required', 'nice_to_have'] },
          alternative_group: { type: ['string', 'null'] },
        },
        required: ['raw_text', 'canonical', 'requirement', 'alternative_group'],
      },
    },
    non_skill_mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw_text: { type: 'string' },
          category: { type: 'string', enum: ['education', 'experience', 'credential', 'soft_skill', 'responsibility'] },
          requirement: { type: ['string', 'null'], enum: ['required', 'nice_to_have', null] },
        },
        required: ['raw_text', 'category', 'requirement'],
      },
    },
  },
  required: ['company', 'title', 'seniority', 'seniority_signal', 'seniority_basis', 'summary', 'skills', 'non_skill_mentions'],
}

const SYSTEM_PROMPT = `You extract structured data from a SINGLE screenshot of a job posting.
The screenshots are PARTIAL: they may start or end mid-section, and the company/title
may be cropped out or shown only as a logo.

CORE RULE: BE HONEST ABOUT ABSENCE. If a field is not visible in this screenshot,
return null. Never guess or fill gaps. "not stated" beats a wrong guess.

Fields:
- company: the hiring company. May be logo-only (read the logo if you can) or cropped out -> null.
- title: the role name. If the screenshot opens mid-section with no title in frame -> null.
- seniority: one of Junior | Mid | Senior. Usually NOT stated outright -- infer it, but
  follow these ladders STRICTLY (do not freelance):
    Years:    <2yr -> Junior, 2-5yr -> Mid, 5+yr -> Senior
    Language: lead/principal/architect/deep expertise -> Senior;
              proven/production/ownership -> Mid;
              eager to learn/initial experience/strong interest -> Junior
- seniority_signal: the exact phrase or years the label keyed off.
- seniority_basis: "stated" if the posting names the level explicitly, else "inferred".
- summary: 1-2 sentences, what this role wants.
- skills: only distinct technical skills this role asks for: a language, framework,
  platform, tool, technical practice, or technical field the candidate must know or use.
  Do NOT include degrees/fields of study used as education qualifications, years or
  prior-work experience, credentials/publications, soft skills, responsibilities, or
  alternative experience paths. Keep every such visible item in non_skill_mentions.
- non_skill_mentions: each excluded item as raw_text + category (education, experience,
  credential, soft_skill, responsibility) + requirement (required/nice_to_have when
  the JD labels it; otherwise null for a responsibility). This is an audit trail, not
  a skills list.
- requirement: "required" or "nice_to_have". A requirement for interest or initial
  experience in a technical topic still names a technical skill; never turn a non-skill
  into a skill merely to give it this label.
- alternative_group: null for ordinary independent skills. For a clearly substitutable
  choice such as "Python or Java", emit BOTH skills with the same local opaque id,
  e.g. "alt-1". A comma-list remains independent even if its final item uses "or":
  "LLMs, prompt engineering, or RAG" is three skills. Do not silently keep only the
  first option. For named technologies in a generic category, emit the named items:
  "cloud platforms (GCP, AWS, or Azure)" -> GCP, AWS, Azure, not "Cloud Platforms";
  group them only when the wording makes them substitutable.

DISCARD UI chrome -- NOT skills: apply buttons, German UI words (Vollzeit), model-name
corner labels (gpt4), verified checkmarks, bookmark/share icons, nav.`

function sandboxCode(pyParams) {
  // pyParams is a double-JSON-encoded string -> a safe Python string literal.
  return `import json, urllib.request
P = json.loads(${pyParams})
body = {
    "model": P["model"],
    "max_tokens": 1024,
    "system": P["system"],
    "tools": [{"name": "record_job", "description": "Record the extracted job fields. Use null for anything not visible.", "input_schema": P["schema"]}],
    "tool_choice": {"type": "tool", "name": "record_job"},
    "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": P["mediaType"], "data": P["image"]}},
        {"type": "text", "text": P["userText"]},
    ]}],
}
req = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(body).encode(),
    headers={"x-api-key": P["apiKey"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
)
resp = json.loads(urllib.request.urlopen(req).read())
out = None
for block in resp.get("content", []):
    if block.get("type") == "tool_use":
        out = block["input"]
        break
print(json.dumps(out))`
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

  const params = JSON.stringify({
    apiKey: modelKey,
    model: MODEL,
    system: SYSTEM_PROMPT,
    userText: USER_TEXT,
    schema: INPUT_SCHEMA,
    image,
    mediaType,
  })
  const pyParams = JSON.stringify(params)

  let sandbox
  try {
    const daytona = new Daytona({ apiKey: daytonaKey })
    // ephemeral + short auto-stop = the sandbox self-deletes even if this function
    // never reaches the explicit delete() below (timeout/error/overlap). Prevents the
    // disk-limit leak from sandboxes piling up.
    sandbox = await daytona.create({ language: 'python', ephemeral: true, autoStopInterval: 2 })
    const r = await sandbox.process.codeRun(sandboxCode(pyParams))
    if (r.exitCode !== 0) {
      return res.status(500).json({ error: 'sandbox error', detail: String(r.result).slice(0, 500) })
    }
    const parsed = JSON.parse(String(r.result).trim())
    if (!parsed) return res.status(500).json({ error: "couldn't parse the screenshot" })
    const job = {
      id: 'live-' + Date.now(),
      source: 'screenshot',
      screenshot_hash: hash,
      // Stamp created_at here so it's both persisted AND returned to the client — the
      // freshly dropped-in job then shows the "New" badge immediately, not just after a
      // reload (isNewJob keys off created_at, which the API otherwise wouldn't return).
      created_at: new Date().toISOString(),
      ...parsed,
      skills: normalizeSkills(parsed.skills, canonicalMap, { withRequirement: true }),
      non_skill_mentions: parsed.non_skill_mentions || [],
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
    return res.status(500).json({ error: String(e) })
  } finally {
    if (sandbox) {
      try { await sandbox.delete() } catch { /* best effort */ }
    }
  }
}
