// T9 testable core — spec C8. TDD RED: pins the contract of the NOT-YET-WRITTEN
// pure module ./session.js that TailorScreen delegates to. Scenarios covered:
// "pill mints a first-class claim", "pill reject leaves no trace",
// "early exit carries over verbatim", "approve transition feeds export",
// "stale split blocks export too", "score fixture pins canonicalMap drift" (CACE),
// "pill-claim id fixture pins canonical naming" (CACE).
import { describe, it, expect } from 'vitest'
import { matchJob } from '../match'
import { sha256Hex } from './anchor'
import {
  computeSkillGap,
  mintPillClaim,
  sessionEvidence,
  assembleSections,
  assertFreshSplit,
  afterScoreSet,
} from './session'

// --- fixtures ----------------------------------------------------------------

const req = (canonical) => ({ canonical, requirement: 'required' })
const nice = (canonical) => ({ canonical, requirement: 'nice_to_have' })
const alternative = (canonical, alternative_group) => ({ canonical, requirement: 'required', alternative_group })

// Blueprint CACE score fixture: three required skills, cv has two.
const fixtureJob = { skills: [req('LLMs'), req('Python'), req('Docker')] }
const fixtureCvSet = new Set(['LLMs', 'Python'])

// full_text with exact character spans — verbatim-slice assertions depend on
// these offsets, so they are computed, not hand-counted.
const HEADER = 'Chandler Shortlidge\nchandler@example.com\n'
const PROJECTS = 'Projects\nBuilt a job pipeline with LLM extraction.\n'
const SKILLS = 'Skills\nPython, LLMs.\n'
const fullText = HEADER + PROJECTS + SKILLS
const sections = [
  { name: '_header', start: 0, end: HEADER.length },
  { name: 'Projects', start: HEADER.length, end: HEADER.length + PROJECTS.length },
  { name: 'Skills', start: HEADER.length + PROJECTS.length, end: fullText.length },
]

// --- computeSkillGap ----------------------------------------------------------

describe('computeSkillGap', () => {
  it('returns required JD skills absent from cv set and every template claim', () => {
    const gap = computeSkillGap({
      jobSkills: [req('Docker'), req('Terraform'), req('Python')],
      cvSkills: ['Python'],
      templates: [{ claims: [{ id: 'jp-1', text: 'Shipped infra', skills: ['Terraform'] }] }],
    })
    expect(gap).toEqual(['Docker'])
  })

  it('ignores nice-to-have JD skills entirely', () => {
    const gap = computeSkillGap({
      jobSkills: [nice('Docker'), req('Rust')],
      cvSkills: [],
      templates: [],
    })
    expect(gap).toEqual(['Rust'])
  })

  it('scans ALL claims across ALL templates for covering skills', () => {
    const gap = computeSkillGap({
      jobSkills: [req('Docker'), req('Kubernetes')],
      cvSkills: [],
      templates: [
        { claims: [{ id: 'jp-1', text: 'a', skills: ['Docker'] }] },
        {
          claims: [
            { id: 'jp-2', text: 'b', skills: [] },
            { id: 'jp-3', text: 'c', skills: ['Kubernetes'] },
          ],
        },
      ],
    })
    expect(gap).toEqual([])
  })

  it('dedupes repeated required canonicals and sorts the result', () => {
    const gap = computeSkillGap({
      jobSkills: [req('Terraform'), req('Docker'), req('Terraform'), req('Airflow')],
      cvSkills: [],
      templates: [],
    })
    expect(gap).toEqual(['Airflow', 'Docker', 'Terraform'])
  })

  it('returns [] when everything required is covered', () => {
    const gap = computeSkillGap({
      jobSkills: [req('Python')],
      cvSkills: ['Python'],
      templates: [],
    })
    expect(gap).toEqual([])
  })

  it('does not offer an alternative-group pill when any option is covered', () => {
    const gap = computeSkillGap({
      jobSkills: [alternative('Python', 'alt-1'), alternative('Java', 'alt-1'), req('Docker')],
      cvSkills: ['Python'],
      templates: [],
    })
    expect(gap).toEqual(['Docker'])
  })
})

// --- mintPillClaim ------------------------------------------------------------

describe('mintPillClaim', () => {
  it('mints the exact pill_claim shape from the data schema', () => {
    expect(mintPillClaim('Docker', '2026-07-13')).toEqual({
      id: 'pill-Docker',
      text: 'Has skill: Docker (self-confirmed 2026-07-13)',
      source: 'pill',
    })
  })

  it('CACE: id for canonical "Docker" is EXACTLY "pill-Docker" (canonicalMap rename must fail loudly)', () => {
    expect(mintPillClaim('Docker', '2026-07-13').id).toBe('pill-Docker')
  })

  it('uses the canonical verbatim — no casing or slug transformation', () => {
    const claim = mintPillClaim('CI/CD', '2026-01-02')
    expect(claim.id).toBe('pill-CI/CD')
    expect(claim.text).toBe('Has skill: CI/CD (self-confirmed 2026-01-02)')
    expect(claim.source).toBe('pill')
  })
})

// --- sessionEvidence ----------------------------------------------------------

describe('sessionEvidence', () => {
  it('returns exactly the confirmed pill claims', () => {
    const docker = mintPillClaim('Docker', '2026-07-13')
    expect(sessionEvidence({ confirmedPills: [docker] })).toEqual([docker])
  })

  it('pill reject leaves no trace: an empty confirm list yields []', () => {
    expect(sessionEvidence({ confirmedPills: [] })).toEqual([])
  })

  it('a rejected skill appears nowhere in the evidence output', () => {
    // Terraform was rejected → it was never confirmed, so it must not surface.
    const out = sessionEvidence({ confirmedPills: [mintPillClaim('Docker', '2026-07-13')] })
    expect(JSON.stringify(out)).not.toContain('Terraform')
    expect(out.map((c) => c.id)).toEqual(['pill-Docker'])
  })
})

// --- assembleSections ---------------------------------------------------------

describe('assembleSections', () => {
  const bullets = [{ text: 'Shipped a job pipeline.', claim_ids: ['jp-1'] }]

  it('early exit carries over verbatim: with nothing approved every section is an exact slice', () => {
    const out = assembleSections({ fullText, sections, approvedByName: {} })
    expect(out).toEqual([
      { name: '_header', carryText: fullText.slice(0, HEADER.length) },
      {
        name: 'Projects',
        carryText: fullText.slice(HEADER.length, HEADER.length + PROJECTS.length),
      },
      {
        name: 'Skills',
        carryText: fullText.slice(HEADER.length + PROJECTS.length, fullText.length),
      },
    ])
  })

  it('approve transition feeds export: approved section gets bullets, all others verbatim carryover', () => {
    const out = assembleSections({
      fullText,
      sections,
      approvedByName: { Projects: bullets },
    })
    expect(out).toEqual([
      { name: '_header', carryText: HEADER },
      { name: 'Projects', bullets },
      { name: 'Skills', carryText: SKILLS },
    ])
  })

  it('preserves stored section order even when approvals arrive out of order', () => {
    const out = assembleSections({
      fullText,
      sections,
      approvedByName: { Skills: bullets, Projects: bullets },
    })
    expect(out.map((s) => s.name)).toEqual(['_header', 'Projects', 'Skills'])
  })

  it('_header is carryover with the exact slice even if someone tries to approve it', () => {
    // Spec C8: the loop skips `_header` — always carryover.
    const out = assembleSections({
      fullText,
      sections,
      approvedByName: { _header: bullets },
    })
    expect(out[0]).toEqual({ name: '_header', carryText: HEADER })
  })

  it('carryover entries never carry bullets and approved entries never carry carryText (buildDocx XOR contract)', () => {
    const out = assembleSections({
      fullText,
      sections,
      approvedByName: { Projects: bullets },
    })
    for (const s of out) {
      expect('bullets' in s !== 'carryText' in s).toBe(true)
    }
  })
})

// --- assertFreshSplit ---------------------------------------------------------

describe('assertFreshSplit', () => {
  it('resolves true when the stored hash matches sha256Hex(fullText)', async () => {
    const full_text_hash = await sha256Hex(fullText)
    await expect(
      assertFreshSplit({ fullText, sectionsMeta: { full_text_hash, sections } }),
    ).resolves.toBe(true)
  })

  it('stale split blocks export too: resolves false when full_text changed after split', async () => {
    const full_text_hash = await sha256Hex(fullText)
    await expect(
      assertFreshSplit({
        fullText: fullText + ' edited in the console',
        sectionsMeta: { full_text_hash, sections },
      }),
    ).resolves.toBe(false)
  })
})

// --- afterScoreSet ------------------------------------------------------------

describe('afterScoreSet', () => {
  it('returns a Set uniting cv skills with confirmed pill canonicals', () => {
    const s = afterScoreSet({
      cvSkills: ['LLMs', 'Python'],
      confirmedPillCanonicals: ['Docker'],
    })
    expect(s).toBeInstanceOf(Set)
    expect([...s].sort()).toEqual(['Docker', 'LLMs', 'Python'])
  })

  it('rejected skills stay out: only confirmed canonicals join the after set', () => {
    // Terraform was rejected, so it is never passed in — and must not appear.
    const s = afterScoreSet({ cvSkills: ['Python'], confirmedPillCanonicals: [] })
    expect(s.has('Terraform')).toBe(false)
    expect([...s]).toEqual(['Python'])
  })

  it('dedupes when a confirmed pill duplicates a cv skill', () => {
    const s = afterScoreSet({ cvSkills: ['Python'], confirmedPillCanonicals: ['Python'] })
    expect(s.size).toBe(1)
  })
})

// --- score fixture (blueprint CACE) — REAL matchJob ---------------------------

describe('score fixture pins canonicalMap drift (CACE)', () => {
  it('fixture job vs Set{LLMs, Python} scores exactly 2/3 with Docker missing', () => {
    const m = matchJob(fixtureJob, fixtureCvSet)
    expect(m.score).toBe(2 / 3)
    expect(m.matched).toEqual(['LLMs', 'Python'])
    expect(m.missing).toEqual(['Docker'])
  })

  it('confirming the Docker pill lifts the after score to 1 via afterScoreSet', () => {
    const after = afterScoreSet({
      cvSkills: [...fixtureCvSet],
      confirmedPillCanonicals: ['Docker'],
    })
    const m = matchJob(fixtureJob, after)
    expect(m.score).toBe(1)
    expect(m.missing).toEqual([])
  })
})
