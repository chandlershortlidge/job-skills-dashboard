/**
 * Creates one real LangSmith baseline experiment from the 20 JD golden attachments.
 * It preflights the remote references and hashes each downloaded image before calling
 * the no-write vision extractor sequentially; scores appear as LangSmith feedback.
 * It does NOT touch Supabase or Storage. It refuses to run without --live --confirm-20.
 * Invariant: no extraction request starts until all remote fixtures match local goldens.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '../dashboard/node_modules/langsmith/index.js'
import { evaluate } from '../dashboard/node_modules/langsmith/evaluation.js'
import canonicalMap from '../dashboard/api/canonicalMap.js'
import { normalizeExtractedTechnicalSkills } from '../dashboard/api/normalizeSkills.js'
import { runAndSummarizeLangSmithBaseline } from '../dashboard/api-lib/jd/langsmithBaseline.js'
import { runVisionExtraction, VISION_MODEL, VISION_PROMPT_SCHEMA_SHA256 } from '../dashboard/api-lib/jd/visionExtraction.js'

const requiredFlags = new Set(['--live', '--confirm-20'])
const providedFlags = new Set(process.argv.slice(2))
if (![...requiredFlags].every((flag) => providedFlags.has(flag))) {
  throw new Error('Refusing live evaluation. Run with --live --confirm-20 after explicit approval.')
}
for (const key of ['LANGSMITH_API_KEY', 'DAYTONA_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[key]) throw new Error(`${key} is required for the live baseline`)
}

const datasetName = process.env.LANGSMITH_DATASET ?? 'jd-skill-extraction-golden-v1'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evalsDirectory = path.join(repoRoot, 'evals')
const execFileAsync = promisify(execFile)

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

const summary = await runAndSummarizeLangSmithBaseline({
  client: new Client({ apiKey: process.env.LANGSMITH_API_KEY }),
  evaluate,
  fixtures: await loadFixtures(),
  datasetName,
  extract: ({ image, mediaType }) => runVisionExtraction({
    image,
    mediaType,
    daytonaApiKey: process.env.DAYTONA_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    normalizeTechnicalSkills: (skills) => normalizeExtractedTechnicalSkills(skills, canonicalMap),
  }),
  metadata: {
    git_sha: await gitSha(),
    model: VISION_MODEL,
    prompt_schema_sha256: VISION_PROMPT_SCHEMA_SHA256,
    execution_mode: 'live',
  },
  summary: {
    dataset: datasetName,
    fixture_count: 20,
    model: VISION_MODEL,
    prompt_schema_sha256: VISION_PROMPT_SCHEMA_SHA256,
    external_writes: 'one LangSmith experiment; no Supabase or Storage writes',
  },
})

console.log(JSON.stringify(summary, null, 2))
