// api-lib/jd/weaveBaseline.js — guarded W&B Weave reporting for JD Golden evaluations.
// Preflights injected local screenshot sources, runs the provider-neutral Golden evaluator,
// and sends its existing per-fixture and aggregate scores through an injected reporter.
// Does NOT initialize W&B, load files/environment variables, call a model directly, upload
// screenshot bytes, or touch LangSmith, Supabase, or Storage.
// Invariant: every source is verified before reporter initialization or extraction begins.

import crypto from 'node:crypto'
import { fixtureManifestSha256, runGoldenEvaluation } from './goldenRunner.js'

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/webp'])
const ALLOWED_METADATA_KEYS = Object.freeze([
  'git_sha',
  'model',
  'prompt_schema_sha256',
  'execution_mode',
  'fixture_count',
  'fixture_manifest_sha256',
])

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
}

function definedEntries(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value != null))
}

export function allowlistedWeaveMetadata(metadata = {}) {
  return definedEntries(ALLOWED_METADATA_KEYS.map((key) => [key, metadata[key]]))
}

// Resolve and verify the complete source set before any external reporter or model can run.
export async function preloadVerifiedGoldenSources({ fixtures, resolveSource }) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new TypeError('fixtures must be a non-empty array')
  assertFunction(resolveSource, 'resolveSource')

  const sourcesByFixtureId = new Map()
  const seenSourceHashes = new Set()
  for (const fixture of fixtures) {
    if (!fixture?.id || !fixture?.source_sha256) throw new Error('each fixture needs id and source_sha256')
    if (sourcesByFixtureId.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`)
    if (seenSourceHashes.has(fixture.source_sha256)) throw new Error(`${fixture.id}: duplicate fixture source SHA-256`)

    const source = await resolveSource(fixture)
    if (!source?.bytes) throw new Error(`${fixture.id}: source resolver returned no image bytes`)
    const bytes = Buffer.from(source.bytes)
    if (bytes.length === 0) throw new Error(`${fixture.id}: source resolver returned empty image bytes`)
    if (!ALLOWED_MEDIA_TYPES.has(source.mediaType)) {
      throw new Error(`${fixture.id}: unsupported source media type: ${source.mediaType ?? 'missing'}`)
    }

    const actualSha256 = sha256(bytes)
    if (actualSha256 !== fixture.source_sha256) {
      throw new Error(`${fixture.id}: source SHA-256 mismatch (expected ${fixture.source_sha256}, got ${actualSha256})`)
    }
    sourcesByFixtureId.set(fixture.id, { bytes, mediaType: source.mediaType })
    seenSourceHashes.add(actualSha256)
  }
  return sourcesByFixtureId
}

// Preserve the existing LangSmith metric names while omitting non-applicable values.
export function weaveScoreMetrics(score) {
  const metrics = [
    ['skill_canonical_precision', score.technical.canonical_precision],
    ['skill_canonical_recall', score.technical.canonical_recall],
    ['skill_requirement_accuracy', score.technical.requirement_accuracy],
    ['non_skill_precision', score.audit.non_skill_precision],
    ['non_skill_recall', score.audit.non_skill_recall],
    ['audit_category_label_accuracy', score.audit.category_label_accuracy],
    ['audit_structured_accuracy', score.audit.structured_accuracy],
  ]
  if (score.technical.expected_alternative_groups > 0) {
    metrics.splice(3, 0, ['skill_alternative_group_accuracy', score.technical.alternative_group_accuracy])
  }
  for (const [category, counts] of Object.entries(score.audit.by_category)) {
    if (counts.expected === 0) continue
    metrics.push(
      [`${category}_precision`, counts.precision],
      [`${category}_recall`, counts.recall],
      [`${category}_support`, counts.expected],
    )
  }
  return definedEntries(metrics)
}

// Log the evaluator's exact aggregate math rather than relying on Weave's default reductions.
export function weaveAggregateSummary(result) {
  const { technical, audit } = result.aggregate
  const summary = [
    ['job_count', result.aggregate.jobs],
    ['skill_canonical_precision', technical.canonical_precision],
    ['skill_canonical_recall', technical.canonical_recall],
    ['skill_requirement_accuracy', technical.requirement_accuracy],
    ['skill_alternative_group_accuracy', technical.alternative_group_accuracy],
    ['skill_alternative_group_jobs', technical.alternative_group_jobs],
    ['non_skill_precision', audit.non_skill_precision],
    ['non_skill_recall', audit.non_skill_recall],
    ['audit_category_label_accuracy', audit.category_label_accuracy],
    ['audit_structured_accuracy', audit.structured_accuracy],
  ]
  for (const [category, counts] of Object.entries(audit.by_category)) {
    summary.push(
      [`${category}_expected`, counts.expected],
      [`${category}_predicted`, counts.predicted],
      [`${category}_matched`, counts.matched],
      [`${category}_precision`, counts.precision],
      [`${category}_recall`, counts.recall],
      [`${category}_support`, counts.support],
    )
  }
  return {
    ...definedEntries(summary),
    ...allowlistedWeaveMetadata(result.metadata),
  }
}

async function logWeaveResult({ reporter, fixtures, result }) {
  if (!reporter?.logPredictionAsync || !reporter?.logSummary) {
    throw new TypeError('reporter must provide logPredictionAsync and logSummary')
  }
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  for (const report of result.reports) {
    const fixture = fixturesById.get(report.id)
    if (!fixture) throw new Error(`${report.id}: evaluated report has no fixture`)
    const prediction = await reporter.logPredictionAsync({
      fixture_id: fixture.id,
      job_description: fixture.job_description,
      source_sha256: fixture.source_sha256,
      expected_extraction: fixture.expected_extraction,
    }, report.actual)
    if (!prediction?.logScore || !prediction?.finish) {
      throw new TypeError('prediction reporter must provide logScore and finish')
    }
    for (const [name, value] of Object.entries(weaveScoreMetrics(report.score))) {
      await prediction.logScore(name, value)
    }
    await prediction.finish()
  }
  await reporter.logSummary(weaveAggregateSummary(result))
}

// Run one sequential Golden evaluation after a complete local preflight, then report it once.
export async function runWeaveBaseline({ fixtures, resolveSource, extract, initializeReporter, metadata = {} }) {
  assertFunction(extract, 'extract')
  assertFunction(initializeReporter, 'initializeReporter')
  const verifiedSources = await preloadVerifiedGoldenSources({ fixtures, resolveSource })
  const completeMetadata = {
    ...metadata,
    fixture_count: fixtures.length,
    fixture_manifest_sha256: fixtureManifestSha256(fixtures),
  }
  const reporter = await initializeReporter(allowlistedWeaveMetadata(completeMetadata))
  const result = await runGoldenEvaluation({
    fixtures,
    resolveSource: (fixture) => verifiedSources.get(fixture.id),
    extract,
    metadata,
  })
  await logWeaveResult({ reporter, fixtures, result })
  return result
}
