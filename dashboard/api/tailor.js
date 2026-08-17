// Vercel serverless function — tailor dispatcher (spec C6, slot 9/12).
// POST {action, ...}: 'transcribe' {cvId, overwrite?} -> {fullText};
// 'split' {cvId} -> {sections:[{name,start,end}]};
// 'generate'/'revise' {jobId, cvId, sectionName, claimIds, pillClaims,
// note?, priorBullets?} -> {bullets, verified, objection?} through the guard
// pipeline (hard provenance -> digit diff -> LLM judge, bounded retries).
// Anthropic calls go direct over fetch (forced tool_use, bodies built by
// api-lib/tailor/prompts.js); PDF bytes come from the private bucket via
// sourceStore.download using the DB row's path — never a client-supplied path.
// No response ever carries API keys, bucket URLs, signed-URL material, or
// prompt text (spec C6 final clause).
import { createClient } from '@supabase/supabase-js'
import { download } from './sourceStore.js'
import {
  buildTranscribeBody,
  buildSplitBody,
  buildPrefix,
  buildSuffix,
  buildGenerateBody,
} from '../api-lib/tailor/prompts.js'
import { judge } from '../api-lib/tailor/judge.js'
import { anchorSections, sha256Hex } from '../src/tailor/anchor.js'
import { validateClaimIds, digitDiff } from '../src/tailor/provenance.js'
import { requiredSkillRequirements } from '../src/skillRequirements.js'

// One Anthropic messages call. Returns the forced tool_use input object, or
// null on non-200 / missing tool block. Network throws propagate to the caller
// (both map to 502 there).
async function callAnthropic(body, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) return null
  const msg = await resp.json()
  const block = (msg.content ?? []).find((b) => b.type === 'tool_use')
  return block?.input ?? null
}

async function loadCv(supabase, cvId) {
  const { data } = await supabase.from('cv').select('*').eq('id', cvId).maybeSingle()
  return data ?? null
}

// transcribe: PDF bytes -> full_text ground truth. A new transcript always
// nulls cv.sections in the same update — any prior split is stale by definition.
async function transcribe(supabase, apiKey, body, res) {
  const cv = await loadCv(supabase, body?.cvId)
  if (!cv) return res.status(404).json({ error: 'cv not found' })
  if (cv.full_text != null && body?.overwrite !== true) {
    return res.status(409).json({ error: 'full_text exists; pass overwrite:true' })
  }
  if (!cv.pdf_path) return res.status(404).json({ error: 'cv has no stored pdf' })
  const bytes = await download(supabase, cv.pdf_path)
  if (!bytes) return res.status(404).json({ error: 'stored pdf not found' })

  let input
  try {
    input = await callAnthropic(buildTranscribeBody({ pdfBase64: bytes.toString('base64') }), apiKey)
  } catch {
    input = null
  }
  const fullText = input?.full_text
  if (typeof fullText !== 'string') return res.status(502).json({ error: 'transcription failed' })

  const { error } = await supabase
    .from('cv')
    .update({ full_text: fullText, sections: null })
    .eq('id', body.cvId)
  if (error) return res.status(500).json({ error: 'persist failed' })
  return res.status(200).json({ fullText })
}

// split: full_text -> section offsets via the model's verbatim quotes,
// anchored (exact then fuzzy) by the REAL anchorSections. Coverage failure is
// loud (422 + gap) and writes nothing; success persists {full_text_hash,
// sections} so generate can detect staleness later.
async function split(supabase, apiKey, body, res) {
  const cv = await loadCv(supabase, body?.cvId)
  if (!cv || cv.full_text == null) return res.status(404).json({ error: 'cv full_text not found' })

  let input
  try {
    input = await callAnthropic(buildSplitBody({ fullText: cv.full_text }), apiKey)
  } catch {
    input = null
  }
  const quotes = input?.sections
  if (!Array.isArray(quotes)) return res.status(502).json({ error: 'split failed' })

  const anchored = anchorSections(cv.full_text, quotes)
  if (!anchored.ok) return res.status(422).json({ error: 'split coverage failed', gap: anchored.gap })

  const stored = { full_text_hash: await sha256Hex(cv.full_text), sections: anchored.sections }
  const { error } = await supabase.from('cv').update({ sections: stored }).eq('id', body.cvId)
  if (error) return res.status(500).json({ error: 'persist failed' })
  return res.status(200).json({ sections: anchored.sections })
}

// One best-effort tailor_log row per guard evaluation (spec C6 step 8).
// Insert failure (returned error OR throw) never fails the request.
async function logGuard(supabase, ctx, guard, pass, objection, bullets, evidence) {
  try {
    await supabase.from('tailor_log').insert({
      job_id: ctx.jobId,
      cv_id: ctx.cvId,
      section: ctx.sectionName,
      guard,
      pass,
      objection,
      payload: { bullets, evidence },
    })
  } catch {
    // best-effort logging only
  }
}

// Run the full guard chain on one generation attempt, logging every
// evaluation. → {kind:'ok'} | {kind:'hard'|'soft', objection} |
// {kind:'judge-error'}. Order is fixed: hard -> digit (short-circuits the
// judge on failure) -> judge (spec C6 steps 5–7).
async function evaluateGuards({ supabase, apiKey, ctx, bullets, evidence }) {
  const hard = validateClaimIds(bullets, evidence.map((e) => e.id))
  await logGuard(supabase, ctx, 'hard', hard.ok, hard.ok ? null : hard.reason, bullets, evidence)
  if (!hard.ok) return { kind: 'hard', objection: hard.reason }

  const digit = digitDiff(bullets, evidence.map((e) => e.text))
  const digitObjection = digit.ok
    ? null
    : `bullet numbers not found in the evidence: ${digit.digits.join(', ')}`
  await logGuard(supabase, ctx, 'digit', digit.ok, digitObjection, bullets, evidence)
  if (!digit.ok) return { kind: 'soft', objection: digitObjection }

  const verdict = await judge({ bullets, evidence, apiKey })
  if (verdict.judgeError === true) {
    await logGuard(supabase, ctx, 'judge-error', false, 'judge unavailable', bullets, evidence)
    return { kind: 'judge-error' }
  }
  await logGuard(supabase, ctx, 'judge', verdict.pass, verdict.objection ?? null, bullets, evidence)
  if (!verdict.pass) return { kind: 'soft', objection: verdict.objection }
  return { kind: 'ok' }
}

// generate/revise: the guard pipeline (spec C6 steps 1–9). Retry budget is a
// hard structural cap: initial call + at most ONE hard retry + at most ONE
// soft retry (max 3 generation calls); any failure on a retry is final.
async function generate(supabase, apiKey, body, res) {
  // 1. cv + split present, and the split must match the CURRENT full_text —
  //    staleness blocks before anything else touches the model.
  const cv = await loadCv(supabase, body?.cvId)
  if (!cv || cv.full_text == null) return res.status(404).json({ error: 'cv full_text not found' })
  const split = cv.sections
  if (!split || !Array.isArray(split.sections)) {
    return res.status(404).json({ error: 'cv split not found' })
  }
  if ((await sha256Hex(cv.full_text)) !== split.full_text_hash) {
    return res.status(409).json({ error: 'stale split — re-run split' })
  }

  // 2. job + its required skills (this job only; explicit alternatives stay one
  // criterion in the prompt) + section span.
  //    Select errors are 500s, not empty results — a transient DB failure must
  //    never silently build a prompt without JD skills (house pattern: file.js).
  const { data: job, error: jobError } = await supabase
    .from('job')
    .select('*')
    .eq('id', body?.jobId)
    .maybeSingle()
  if (jobError) return res.status(500).json({ error: 'lookup failed' })
  if (!job) return res.status(404).json({ error: 'job not found' })
  const { data: skillRows, error: skillError } = await supabase
    .from('skill')
    .select('canonical, alternative_group')
    .eq('job_id', body.jobId)
    .eq('requirement', 'required')
  if (skillError) return res.status(500).json({ error: 'lookup failed' })
  const jdSkills = requiredSkillRequirements(skillRows ?? []).map((r) => r.label)
  const span = split.sections.find((s) => s.name === body?.sectionName)
  if (!span) return res.status(404).json({ error: 'section not found' })
  // orig-claim: minted server-side from the persisted transcript slice.
  const origClaim = { id: `orig-${span.name}`, text: cv.full_text.slice(span.start, span.end) }

  // 3. Resolve evidence. ALL templates load; claim ids must be globally unique.
  const { data: templates, error: templateError } = await supabase.from('project_template').select('*')
  if (templateError) return res.status(500).json({ error: 'lookup failed' })
  const claimById = new Map()
  const templateByClaimId = new Map()
  for (const template of templates ?? []) {
    for (const claim of template.claims ?? []) {
      if (claimById.has(claim.id)) {
        return res.status(500).json({
          error: `duplicate claim id "${claim.id}" in templates "${templateByClaimId.get(claim.id)}" and "${template.name}"`,
        })
      }
      claimById.set(claim.id, claim)
      templateByClaimId.set(claim.id, template.name)
    }
  }
  const claimIds = Array.isArray(body?.claimIds) ? body.claimIds : []
  const selected = []
  for (const id of claimIds) {
    const claim = claimById.get(id)
    if (!claim) return res.status(400).json({ error: `unknown claim id "${id}"` })
    selected.push(claim)
  }
  const pillClaims = Array.isArray(body?.pillClaims) ? body.pillClaims : []
  for (const pill of pillClaims) {
    const ok =
      pill &&
      typeof pill.id === 'string' &&
      pill.id.startsWith('pill-') &&
      typeof pill.text === 'string' &&
      pill.text.length > 0
    if (!ok) return res.status(400).json({ error: 'malformed pillClaims' })
  }
  // evidence = selected template claims ∪ pill claims ∪ orig-claim, as {id, text}.
  const evidence = [
    ...selected.map((c) => ({ id: c.id, text: c.text })),
    ...pillClaims.map((p) => ({ id: p.id, text: p.text })),
    origClaim,
  ]

  // 4. Prompt: cached prefix (full corpus, catalog-framed) is stable across
  //    retries; per-request material (allowlist, note, priorBullets, guard
  //    objection) rides the suffix only.
  const allClaims = [
    ...(templates ?? []).flatMap((t) => t.claims ?? []),
    ...pillClaims.map((p) => ({ id: p.id, text: p.text, skills: [] })),
  ]
  const prefix = buildPrefix({ fullText: cv.full_text, jdSkills, allClaims })
  const generateOnce = async (objection) => {
    const suffix = buildSuffix({
      sectionName: span.name,
      origClaim: origClaim.text,
      selectedClaimIds: claimIds,
      pillClaimIds: pillClaims.map((p) => p.id),
      note: body?.note,
      priorBullets: body?.priorBullets,
      objection,
    })
    try {
      return await callAnthropic(buildGenerateBody({ prefix, suffix }), apiKey)
    } catch {
      return null
    }
  }

  // 5–7. Guard loop with the structural retry cap.
  const ctx = { jobId: body.jobId, cvId: body.cvId, sectionName: span.name }
  let hardRetryUsed = false
  let softRetryUsed = false
  let objection = null
  for (;;) {
    const input = await generateOnce(objection)
    if (input == null) return res.status(502).json({ error: 'generation failed' })
    const bullets = input.bullets
    const result = await evaluateGuards({ supabase, apiKey, ctx, bullets, evidence })

    if (result.kind === 'ok') return res.status(200).json({ bullets, verified: true })
    if (result.kind === 'judge-error') {
      // Infra failure, not content: degrade open, never retry, never 502.
      return res.status(200).json({ bullets, verified: false, objection: 'judge unavailable' })
    }
    if (result.kind === 'hard') {
      if (!hardRetryUsed && !softRetryUsed) {
        hardRetryUsed = true
        objection = result.objection
        continue
      }
      return res.status(422).json({ error: 'generation failed provenance', reason: result.objection })
    }
    // soft failure (digit or judge content verdict)
    if (!softRetryUsed) {
      softRetryUsed = true
      objection = result.objection
      continue
    }
    return res.status(200).json({ bullets, verified: false, objection: result.objection })
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'bad JSON body' })
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!url || !key || !apiKey) return res.status(500).json({ error: 'tailor not configured' })
  const supabase = createClient(url, key)

  switch (body?.action) {
    case 'transcribe':
      return transcribe(supabase, apiKey, body, res)
    case 'split':
      return split(supabase, apiKey, body, res)
    case 'generate':
    case 'revise':
      return generate(supabase, apiKey, body, res)
    default:
      return res.status(400).json({ error: 'unknown action' })
  }
}
