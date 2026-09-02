/**
 * Runs the safe, local foundation for the 20-fixture JD baseline evaluation.
 * It loads local screenshots by their golden checksums, uses a fixture-echo mock
 * extractor, and prints inspectable scores and run metadata.
 * It does NOT call a model, Daytona, LangSmith, Supabase, or Storage, and writes no files.
 * Invariant: every fixture must resolve to exactly one local image with the recorded hash.
 */

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGoldenEvaluation } from '../dashboard/api-lib/jd/goldenRunner.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evalsDirectory = path.join(repoRoot, 'evals')
const screenshotsDirectory = process.env.GOLDEN_SCREENSHOTS_DIR ?? path.join(repoRoot, 'scratch', 'screenshots')

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function mediaTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  throw new Error(`unsupported screenshot type: ${filePath}`)
}

function percentage(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

async function gitSha() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

async function loadFixtures() {
  const files = (await readdir(evalsDirectory)).filter((file) => /^golden_\d+\.jsonl$/.test(file)).sort()
  const fixtures = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(evalsDirectory, file), 'utf8'))))
  if (fixtures.length !== 20) throw new Error(`expected 20 golden fixtures, found ${fixtures.length}`)
  return fixtures
}

async function localSourceResolver() {
  const files = (await readdir(screenshotsDirectory)).filter((file) => /\.(png|webp)$/i.test(file))
  const sourcesByHash = new Map()
  for (const file of files) {
    const filePath = path.join(screenshotsDirectory, file)
    const bytes = await readFile(filePath)
    const hash = sha256(bytes)
    const matches = sourcesByHash.get(hash) ?? []
    matches.push({ bytes, mediaType: mediaTypeFor(filePath), localFile: path.relative(repoRoot, filePath) })
    sourcesByHash.set(hash, matches)
  }

  return (fixture) => {
    const matches = sourcesByHash.get(fixture.source_sha256) ?? []
    if (matches.length !== 1) {
      throw new Error(`${fixture.id}: expected exactly one local screenshot for ${fixture.source_sha256}, found ${matches.length}`)
    }
    return matches[0]
  }
}

function fixtureEchoExtractor(fixtures) {
  const expectedBySourceHash = new Map()
  for (const fixture of fixtures) {
    if (expectedBySourceHash.has(fixture.source_sha256)) throw new Error(`duplicate fixture source hash: ${fixture.source_sha256}`)
    expectedBySourceHash.set(fixture.source_sha256, fixture.expected_extraction)
  }

  return async ({ image, mediaType }) => {
    if (!['image/png', 'image/webp'].includes(mediaType)) throw new Error(`unsupported media type: ${mediaType}`)
    const expected = expectedBySourceHash.get(sha256(Buffer.from(image, 'base64')))
    if (!expected) throw new Error('mock extractor received an unrecognized source image')
    return {
      company: null,
      title: null,
      seniority: null,
      seniority_signal: null,
      seniority_basis: null,
      summary: null,
      skills: expected.technical_skills,
      non_skill_mentions: expected.non_skill_mentions,
    }
  }
}

const fixtures = await loadFixtures()
const result = await runGoldenEvaluation({
  fixtures,
  resolveSource: await localSourceResolver(),
  extract: fixtureEchoExtractor(fixtures),
  metadata: {
    git_sha: await gitSha(),
    execution_mode: 'mock',
    model: 'not-run',
    prompt_schema_version: 'not-run',
  },
})

console.log(JSON.stringify({
  metadata: result.metadata,
  aggregate: result.aggregate,
  reports: result.reports.map(({ id, local_file, source_sha256, score }) => ({ id, local_file, source_sha256, score })),
}, null, 2))
console.log(`technical: precision ${percentage(result.aggregate.technical.canonical_precision)}, recall ${percentage(result.aggregate.technical.canonical_recall)}, requirement ${percentage(result.aggregate.technical.requirement_accuracy)}, alternatives ${percentage(result.aggregate.technical.alternative_group_accuracy)} across ${result.aggregate.technical.alternative_group_jobs} applicable fixtures`)
console.log(`non-skill: precision ${percentage(result.aggregate.audit.non_skill_precision)}, recall ${percentage(result.aggregate.audit.non_skill_recall)}, category label ${percentage(result.aggregate.audit.category_label_accuracy)}, structured ${percentage(result.aggregate.audit.structured_accuracy)}`)
for (const [category, score] of Object.entries(result.aggregate.audit.by_category)) {
  console.log(`${category}: precision ${percentage(score.precision)}, recall ${percentage(score.recall)}, support ${score.support}`)
}
console.log('external writes: 0 (mock-only runner; no LangSmith, Daytona, Supabase, or Storage client is created)')
