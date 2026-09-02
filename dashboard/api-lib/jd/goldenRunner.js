// api-lib/jd/goldenRunner.js — deterministic orchestration for JD golden evaluations.
// Resolves injected screenshot sources, invokes an injected extractor, and scores every
// response against its fixture with reproducible run metadata.
// Does NOT call an LLM, Daytona, LangSmith, Supabase, Storage, the filesystem, or Git.
// Invariant: every evaluated image must exactly match its fixture SHA-256; alternative
// group accuracy is averaged only across fixtures that actually define alternatives.

import crypto from 'node:crypto'
import { REPORTED_NON_SKILL_CATEGORIES, scoreExtraction } from './scoreExtraction.js'

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function average(values) {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
}

// Hash every field of every fixture, sorted by id, so a changed expectation has a new run identity.
export function fixtureManifestSha256(fixtures) {
  if (!Array.isArray(fixtures)) throw new TypeError('fixtures must be an array')
  const manifest = [...fixtures].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  return sha256(JSON.stringify(manifest))
}

// Aggregate per-fixture scores as macro averages, keeping choice-group accuracy applicable-only.
export function aggregateGoldenScores(reports) {
  if (!Array.isArray(reports)) throw new TypeError('reports must be an array')
  const technical = reports.map((report) => report.score.technical)
  const audit = reports.map((report) => report.score.audit)
  const alternativeScores = technical
    .filter((score) => score.expected_alternative_groups > 0)
    .map((score) => score.alternative_group_accuracy)

  return {
    jobs: reports.length,
    technical: {
      canonical_precision: average(technical.map((score) => score.canonical_precision)),
      canonical_recall: average(technical.map((score) => score.canonical_recall)),
      requirement_accuracy: average(technical.map((score) => score.requirement_accuracy)),
      alternative_group_accuracy: average(alternativeScores),
      alternative_group_jobs: alternativeScores.length,
    },
    audit: {
      non_skill_precision: average(audit.map((score) => score.non_skill_precision)),
      non_skill_recall: average(audit.map((score) => score.non_skill_recall)),
      category_label_accuracy: average(audit.map((score) => score.category_label_accuracy)),
      structured_accuracy: average(audit.map((score) => score.structured_accuracy)),
      by_category: Object.fromEntries(REPORTED_NON_SKILL_CATEGORIES.map((category) => {
        const counts = audit.map((score) => score.by_category[category])
        const expected = counts.reduce((total, score) => total + score.expected, 0)
        const predicted = counts.reduce((total, score) => total + score.predicted, 0)
        const matched = counts.reduce((total, score) => total + score.matched, 0)
        return [category, {
          expected,
          predicted,
          matched,
          precision: predicted === 0 ? null : matched / predicted,
          recall: expected === 0 ? null : matched / expected,
          support: expected,
        }]
      })),
    },
  }
}

// Evaluate supplied fixtures without owning I/O or any external system access.
export async function runGoldenEvaluation({ fixtures, resolveSource, extract, metadata = {} }) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new TypeError('fixtures must be a non-empty array')
  assertFunction(resolveSource, 'resolveSource')
  assertFunction(extract, 'extract')

  const reports = []
  for (const fixture of fixtures) {
    const source = await resolveSource(fixture)
    if (!source?.bytes) throw new Error(`${fixture.id}: source resolver returned no image bytes`)

    const bytes = Buffer.from(source.bytes)
    const actualSha256 = sha256(bytes)
    if (actualSha256 !== fixture.source_sha256) {
      throw new Error(`${fixture.id}: source SHA-256 mismatch (expected ${fixture.source_sha256}, got ${actualSha256})`)
    }
    if (!source.mediaType) throw new Error(`${fixture.id}: source resolver returned no media type`)

    const actual = await extract({ image: bytes.toString('base64'), mediaType: source.mediaType })
    reports.push({
      id: fixture.id,
      source_file: fixture.source_file,
      local_file: source.localFile ?? null,
      source_sha256: actualSha256,
      actual,
      score: scoreExtraction(actual, fixture.expected_extraction),
    })
  }

  return {
    metadata: {
      ...metadata,
      fixture_count: fixtures.length,
      fixture_manifest_sha256: fixtureManifestSha256(fixtures),
    },
    reports,
    aggregate: aggregateGoldenScores(reports),
  }
}
