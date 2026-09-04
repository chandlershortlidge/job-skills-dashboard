/**
 * Creates one W&B Weave evaluation from the 20 local JD Golden fixtures.
 * It preflights every local screenshot before initializing Weave, then runs the no-write
 * vision extractor sequentially and logs the existing deterministic scores and aggregates.
 * It does NOT upload screenshot bytes or touch LangSmith, Supabase, or Storage.
 * Invariant: it refuses to run without --live --confirm-20 and a full verified source set.
 */

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as weave from '../dashboard/node_modules/weave/dist/index.mjs'
import canonicalMap from '../dashboard/api/canonicalMap.js'
import { normalizeExtractedTechnicalSkills } from '../dashboard/api/normalizeSkills.js'
import { runVisionExtraction, VISION_MODEL, VISION_PROMPT_SCHEMA_SHA256 } from '../dashboard/api-lib/jd/visionExtraction.js'
import { runWeaveBaseline, weaveEvaluationLoggerOptions } from '../dashboard/api-lib/jd/weaveBaseline.js'

const requiredFlags = new Set(['--live', '--confirm-20'])
const providedFlags = new Set(process.argv.slice(2))
if (![...requiredFlags].every((flag) => providedFlags.has(flag))) {
  throw new Error('Refusing live evaluation. Run with --live --confirm-20 after explicit approval.')
}
for (const key of ['WANDB_API_KEY', 'WANDB_PROJECT', 'DAYTONA_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[key]) throw new Error(`${key} is required for the live W&B baseline`)
}
if (!process.env.WANDB_PROJECT.includes('/')) {
  throw new Error('WANDB_PROJECT must use the entity/project form')
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evalsDirectory = path.join(repoRoot, 'evals')
const screenshotsDirectory = process.env.GOLDEN_SCREENSHOTS_DIR ?? path.join(repoRoot, 'scratch', 'screenshots')
const execFileAsync = promisify(execFile)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function mediaTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  throw new Error(`unsupported screenshot type: ${filePath}`)
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
    matches.push({ bytes, mediaType: mediaTypeFor(filePath) })
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

const fixtures = await loadFixtures()
const result = await runWeaveBaseline({
  fixtures,
  resolveSource: await localSourceResolver(),
  extract: ({ image, mediaType }) => runVisionExtraction({
    image,
    mediaType,
    daytonaApiKey: process.env.DAYTONA_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    normalizeTechnicalSkills: (skills) => normalizeExtractedTechnicalSkills(skills, canonicalMap),
  }),
  initializeReporter: async (metadata) => {
    await weave.init(process.env.WANDB_PROJECT)
    return new weave.EvaluationLogger(weaveEvaluationLoggerOptions({
      name: 'jd-skill-extraction-baseline',
      description: '20-fixture JD vision extraction Golden evaluation',
      model: VISION_MODEL,
      metadata,
    }))
  },
  metadata: {
    git_sha: await gitSha(),
    model: VISION_MODEL,
    prompt_schema_sha256: VISION_PROMPT_SCHEMA_SHA256,
    execution_mode: 'live',
  },
})
await weave.flush()

console.log(JSON.stringify({
  project: process.env.WANDB_PROJECT,
  evaluation: 'jd-skill-extraction-baseline',
  fixture_count: result.metadata.fixture_count,
  fixture_manifest_sha256: result.metadata.fixture_manifest_sha256,
  model: VISION_MODEL,
  prompt_schema_sha256: VISION_PROMPT_SCHEMA_SHA256,
  completed_run_count: result.reports.length,
  aggregate: result.aggregate,
  external_writes: 'one W&B Weave evaluation; no LangSmith, Supabase, or Storage writes',
}, null, 2))
