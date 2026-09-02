// Vercel serverless function — Resume match (Phase 4 stretch, additive).
// POST { pdf: <base64>, media_type } -> extracts the candidate's skills INSIDE a Daytona
// sandbox (stdlib urllib, no pip), normalizes them to the chart's canonicals, and returns
// { profile }. The front-end matches the profile against jobs.json client-side.
//
// Mirrors api/extract.js (the proven JD drop-in) exactly, swapping the image content block
// for a PDF `document` block. Kept as a SEPARATE file so the working drop-in can't regress.
//
// Env vars (Vercel project settings): DAYTONA_API_KEY, ANTHROPIC_API_KEY.
import { Daytona } from '@daytona/sdk'
import { createClient } from '@supabase/supabase-js'
import canonicalMap from './canonicalMap.js'
import { normalizeSkills } from './normalizeSkills.js'
import { uploadCvPdf } from './sourceStore.js'

// Service-role Supabase client, or null if not configured — persistence and PDF
// storage both degrade gracefully (the user still gets their profile) when absent.
function supaClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return url && key ? createClient(url, key) : null
}

// Name a saved résumé after the uploaded file (extension stripped). Falls back to the
// old "title — date" form when the client didn't send a filename.
function cvName(profile, filename) {
  const base = (filename || '').replace(/\.[^.]+$/, '').trim()
  if (base) return base
  return `${profile.title || 'Résumé'} — ${new Date().toISOString().slice(0, 10)}`
}

// Best-effort save of a parsed résumé profile to the cv table. Returns { id, name }
// on success, null otherwise — never throws into the request path.
async function persistCv(supabase, profile, filename) {
  if (!supabase) return null
  const name = cvName(profile, filename)
  const { data, error } = await supabase
    .from('cv')
    .insert({ name, skills: profile.skills, raw_profile: profile })
    .select('id')
    .single()
  if (error) throw error
  return { id: data.id, name }
}

const MODEL = 'claude-sonnet-4-6'

const USER_TEXT = "Extract the candidate's technical skills from this resume."

// Plain JSON schema (no $ref) for the tool the model must call.
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    years_experience: { type: ['number', 'null'] },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw_text: { type: 'string' },
          canonical: { type: 'string' },
        },
        required: ['raw_text', 'canonical'],
      },
    },
  },
  required: ['title', 'years_experience', 'skills'],
}

const SYSTEM_PROMPT = `You extract a candidate's TECHNICAL skills from their resume/CV (a PDF).

List the distinct technical skills, tools, programming languages, frameworks, libraries, and
platforms the candidate actually has experience with -- drawn from their work experience,
projects, and any skills section. BE HONEST: only include skills evidenced in the document;
do not pad the list with things that aren't there.

For each skill give:
- raw_text: the skill as written in the resume.
- canonical: a normalized name for it.

Also extract:
- title: the candidate's most recent or target role (null if unclear).
- years_experience: total professional years if statable from the resume, else null.

DISCARD soft skills and generic words -- NOT skills: teamwork, communication, leadership,
problem-solving, attention to detail, languages spoken, hobbies. Technical only.`

function sandboxCode(pyParams) {
  // pyParams is a double-JSON-encoded string -> a safe Python string literal.
  return `import json, urllib.request
P = json.loads(${pyParams})
body = {
    "model": P["model"],
    "max_tokens": 1024,
    "system": P["system"],
    "tools": [{"name": "record_resume", "description": "Record the candidate's extracted technical skills.", "input_schema": P["schema"]}],
    "tool_choice": {"type": "tool", "name": "record_resume"},
    "messages": [{"role": "user", "content": [
        {"type": "document", "source": {"type": "base64", "media_type": P["mediaType"], "data": P["pdf"]}},
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
  const pdf = body?.pdf
  const mediaType = body?.media_type || 'application/pdf'
  const filename = body?.filename
  if (!pdf) return res.status(400).json({ error: 'no pdf provided' })

  const params = JSON.stringify({
    apiKey: modelKey,
    model: MODEL,
    system: SYSTEM_PROMPT,
    userText: USER_TEXT,
    schema: INPUT_SCHEMA,
    pdf,
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
    if (!parsed) return res.status(500).json({ error: "couldn't parse the resume" })
    const profile = {
      title: parsed.title ?? null,
      years_experience: parsed.years_experience ?? null,
      skills: normalizeSkills(parsed.skills, canonicalMap),
    }
    const supabase = supaClient()
    let cv = null
    try {
      cv = await persistCv(supabase, profile, filename) // save so it can be toggled without re-uploading; best-effort
    } catch (e) {
      console.error('persistCv failed', e)
    }
    // Store the source PDF for the tailored-résumé feature (capture-only in v1 —
    // no retrieval route for CVs, see storage-blueprint.md D1). cv.id is a serial
    // integer, so the insert must come first; then stamp pdf_path on the row.
    // Both best-effort: a storage failure never fails the upload.
    if (cv) {
      const path = await uploadCvPdf(supabase, Buffer.from(pdf, 'base64'), cv.id)
      if (path) {
        const { error } = await supabase.from('cv').update({ pdf_path: path }).eq('id', cv.id)
        // On failure the file stays orphaned by column — delete-cleanup removes by
        // prefix regardless of the column, so it remains reachable (orphan rule).
        if (error) console.error('pdf_path update failed:', error)
      }
    }
    return res.status(200).json({ profile, cv })
  } catch (e) {
    return res.status(500).json({ error: String(e) })
  } finally {
    if (sandbox) {
      try { await sandbox.delete() } catch { /* best effort */ }
    }
  }
}
