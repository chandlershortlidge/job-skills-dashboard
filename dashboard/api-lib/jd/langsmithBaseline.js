// api-lib/jd/langsmithBaseline.js — guarded LangSmith orchestration for JD baselines.
// Verifies a remote dataset and all attached images against committed fixtures, invokes an
// injected no-write extractor, and emits deterministic score metrics.
// Does NOT create clients, load environment variables, call Daytona/LLMs itself, or write
// Supabase/Storage. Calling runLangSmithBaseline intentionally creates one LangSmith experiment.
// Invariant: every remote example and attachment must exactly match a local fixture before
// the target can invoke extraction; experiment predictions run sequentially.

import crypto from 'node:crypto'
import { fixtureManifestSha256 } from './goldenRunner.js'
import { scoreExtraction } from './scoreExtraction.js'

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]))
  return value
}

function sameJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right))
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function fixturesByDescription(fixtures) {
  const byDescription = new Map()
  for (const fixture of fixtures) {
    if (!fixture?.id || !fixture?.job_description) throw new Error('each local fixture needs id and job_description')
    if (byDescription.has(fixture.job_description)) throw new Error(`duplicate local job_description: ${fixture.id}`)
    byDescription.set(fixture.job_description, fixture)
  }
  return byDescription
}

function onlyAttachment(attachments, fixtureId) {
  const entries = Object.entries(attachments ?? {})
  if (entries.length !== 1) throw new Error(`${fixtureId}: expected exactly one LangSmith attachment, found ${entries.length}`)
  const [name, attachment] = entries[0]
  if (!attachment?.presigned_url || !attachment?.mime_type) throw new Error(`${fixtureId}: attachment ${name} lacks presigned_url or mime_type`)
  return { name, attachment }
}

function metric(key, score) {
  return { key, score }
}

// Validate a remote dataset's complete reference contract before extraction starts.
export function preflightLangSmithExamples(fixtures, examples) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new TypeError('fixtures must be a non-empty array')
  if (!Array.isArray(examples)) throw new TypeError('examples must be an array')
  if (examples.length !== fixtures.length) throw new Error(`expected ${fixtures.length} LangSmith examples, found ${examples.length}`)

  const byDescription = fixturesByDescription(fixtures)
  const seenFixtureIds = new Set()
  for (const example of examples) {
    const fixture = byDescription.get(example.inputs?.job_description)
    if (!fixture) throw new Error(`${example.id}: remote job_description has no local fixture`)
    if (seenFixtureIds.has(fixture.id)) throw new Error(`${fixture.id}: duplicate remote LangSmith example`)
    seenFixtureIds.add(fixture.id)
    onlyAttachment(example.attachments, fixture.id)
    if (!example.outputs?.expected_extraction) throw new Error(`${fixture.id}: remote outputs.expected_extraction is required`)
    if (!sameJson(example.outputs.expected_extraction, fixture.expected_extraction)) {
      throw new Error(`${fixture.id}: remote expected_extraction differs from the local fixture`)
    }
  }
  if (seenFixtureIds.size !== fixtures.length) throw new Error('remote LangSmith dataset is missing one or more local fixtures')
  return examples
}

// Translate one extraction score into the numeric LangSmith feedback entries for that run.
export function langSmithScoreEvaluator({ outputs, referenceOutputs }) {
  if (!referenceOutputs?.expected_extraction) throw new Error('referenceOutputs.expected_extraction is required')
  const score = scoreExtraction(outputs, referenceOutputs.expected_extraction)
  const results = [
    metric('skill_canonical_precision', score.technical.canonical_precision),
    metric('skill_canonical_recall', score.technical.canonical_recall),
    metric('skill_requirement_accuracy', score.technical.requirement_accuracy),
    metric('non_skill_precision', score.audit.non_skill_precision),
    metric('non_skill_recall', score.audit.non_skill_recall),
    metric('audit_category_label_accuracy', score.audit.category_label_accuracy),
    metric('audit_structured_accuracy', score.audit.structured_accuracy),
  ]
  for (const [category, counts] of Object.entries(score.audit.by_category)) {
    if (counts.expected === 0) continue
    results.push(
      metric(`${category}_precision`, counts.precision ?? 0),
      metric(`${category}_recall`, counts.recall ?? 0),
      metric(`${category}_support`, counts.expected),
    )
  }
  if (score.technical.expected_alternative_groups > 0) {
    results.splice(3, 0, metric('skill_alternative_group_accuracy', score.technical.alternative_group_accuracy))
  }
  return results
}

// Download and verify every dataset attachment before an evaluation starts model calls.
export async function preloadLangSmithAttachments(fixtures, examples, fetchImpl = fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const byDescription = fixturesByDescription(fixtures)
  const sourcesByFixtureId = new Map()
  for (const example of examples) {
    const fixture = byDescription.get(example.inputs?.job_description)
    if (!fixture) throw new Error(`${example.id}: remote job_description has no local fixture`)
    const { name, attachment } = onlyAttachment(example.attachments, fixture.id)
    const response = await fetchImpl(attachment.presigned_url)
    if (!response.ok) throw new Error(`${fixture.id}: attachment download failed (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actualSha256 = sha256(bytes)
    if (actualSha256 !== fixture.source_sha256) {
      throw new Error(`${fixture.id}: attachment SHA-256 mismatch (expected ${fixture.source_sha256}, got ${actualSha256})`)
    }
    sourcesByFixtureId.set(fixture.id, { bytes, mediaType: attachment.mime_type, attachmentName: name })
  }
  if (sourcesByFixtureId.size !== fixtures.length) throw new Error('not every local fixture has a verified LangSmith attachment')
  return sourcesByFixtureId
}

// Build the evaluate() target from attachment bytes already verified by the preflight.
export function buildLangSmithExtractionTarget({ fixtures, extract, verifiedSources }) {
  if (typeof extract !== 'function') throw new TypeError('extract must be a function')
  if (!(verifiedSources instanceof Map)) throw new TypeError('verifiedSources must be a Map')
  const byDescription = fixturesByDescription(fixtures)

  return async (inputs) => {
    const fixture = byDescription.get(inputs?.job_description)
    if (!fixture) throw new Error('LangSmith target input has no matching local fixture')
    const source = verifiedSources.get(fixture.id)
    if (!source) throw new Error(`${fixture.id}: no preloaded verified attachment`)
    return extract({ image: source.bytes.toString('base64'), mediaType: source.mediaType })
  }
}

// Create one LangSmith experiment after a full reference preflight; external writes happen in evaluate().
export async function runLangSmithBaseline({ client, evaluate, fixtures, datasetName, extract, metadata = {}, fetchImpl = fetch }) {
  if (!client?.listExamples) throw new TypeError('client.listExamples is required')
  if (typeof evaluate !== 'function') throw new TypeError('evaluate must be a function')
  if (!datasetName) throw new Error('datasetName is required')

  const examples = []
  for await (const example of client.listExamples({ datasetName, includeAttachments: true })) examples.push(example)
  preflightLangSmithExamples(fixtures, examples)
  const verifiedSources = await preloadLangSmithAttachments(fixtures, examples, fetchImpl)

  return evaluate(buildLangSmithExtractionTarget({ fixtures, extract, verifiedSources }), {
    client,
    data: examples,
    includeAttachments: true,
    evaluators: [langSmithScoreEvaluator],
    experimentPrefix: 'jd-skill-extraction-baseline',
    maxConcurrency: 1,
    metadata: {
      ...metadata,
      fixture_count: fixtures.length,
      fixture_manifest_sha256: fixtureManifestSha256(fixtures),
    },
  })
}

// Run the baseline and turn its already-complete result into the CLI's final JSON summary.
export async function runAndSummarizeLangSmithBaseline({ runBaseline = runLangSmithBaseline, summary, ...baselineOptions }) {
  if (typeof runBaseline !== 'function') throw new TypeError('runBaseline must be a function')
  const results = await runBaseline(baselineOptions)
  return {
    ...summary,
    experiment_name: results.experimentName,
    completed_run_count: results.length,
  }
}
