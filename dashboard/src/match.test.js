import { describe, it, expect } from 'vitest'
import { matchJob } from './match'

const job = (skills) => ({ skills })
const req = (canonical) => ({ canonical, raw_text: canonical, requirement: 'required' })
const nice = (canonical) => ({ canonical, raw_text: canonical, requirement: 'nice_to_have' })
const alternative = (canonical, group, requirement = 'required') => ({
  canonical, raw_text: canonical, requirement, alternative_group: group,
})

describe('matchJob', () => {
  it('splits required skills into have (matched) and missing', () => {
    const j = job([req('Python'), req('LLMs'), req('RAG'), req('Kubernetes')])
    const m = matchJob(j, new Set(['Python', 'LLMs', 'RAG', 'FastAPI']))
    expect(m.matched).toEqual(['Python', 'LLMs', 'RAG'])
    expect(m.missing).toEqual(['Kubernetes'])
  })

  it('scores the share of required skills covered', () => {
    const j = job([req('Python'), req('LLMs'), req('RAG'), req('Kubernetes')])
    expect(matchJob(j, new Set(['Python', 'LLMs', 'RAG'])).score).toBe(0.75)
  })

  it('lets specific evidence satisfy itself and an explicit broad parent', () => {
    const j = job([req('LLMs'), req('RAG'), req('Prompt engineering')])
    const m = matchJob(j, new Set(['RAG']))

    expect(m.matched).toEqual(['LLMs', 'RAG'])
    expect(m.missing).toEqual(['Prompt engineering'])
    expect(m.score).toBe(2 / 3)
  })

  it('never lets broad evidence satisfy a specific child', () => {
    const j = job([req('LLMs'), req('RAG'), req('Prompt engineering')])
    const m = matchJob(j, new Set(['LLMs']))

    expect(m.matched).toEqual(['LLMs'])
    expect(m.missing).toEqual(['RAG', 'Prompt engineering'])
  })

  it('counts an implied parent once when multiple children support it', () => {
    const j = job([req('LLMs'), req('RAG'), req('Prompt engineering')])
    const m = matchJob(j, new Set(['RAG', 'Prompt engineering']))

    expect(m.matched).toEqual(['LLMs', 'RAG', 'Prompt engineering'])
    expect(m.score).toBe(1)
  })

  it('ignores nice-to-have skills entirely', () => {
    const m = matchJob(job([req('Python'), nice('Docker')]), new Set(['Python']))
    expect(m.matched).toEqual(['Python'])
    expect(m.missing).toEqual([]) // Docker is nice-to-have -> not scored
    expect(m.score).toBe(1)
  })

  it('dedupes required canonicals before scoring', () => {
    const m = matchJob(job([req('Python'), req('Python'), req('RAG')]), new Set(['Python']))
    expect(m.matched).toEqual(['Python']) // counted once
    expect(m.missing).toEqual(['RAG'])
    expect(m.score).toBe(0.5)
  })

  it('returns score 0 and no chips when there are no required skills', () => {
    const m = matchJob(job([nice('Docker')]), new Set(['Docker']))
    expect(m.matched).toEqual([])
    expect(m.missing).toEqual([])
    expect(m.score).toBe(0)
  })

  it('a full miss scores 0', () => {
    const m = matchJob(job([req('Rust'), req('Go')]), new Set(['Python']))
    expect(m.matched).toEqual([])
    expect(m.missing).toEqual(['Rust', 'Go'])
    expect(m.score).toBe(0)
  })

  it('treats explicit alternatives as one required criterion', () => {
    const j = job([alternative('Python', 'alt-1'), alternative('Java', 'alt-1'), req('LLMs')])
    const python = matchJob(j, new Set(['Python', 'LLMs']))
    expect(python.matched).toEqual(['Python or Java', 'LLMs'])
    expect(python.missing).toEqual([])
    expect(python.score).toBe(1)

    const neither = matchJob(j, new Set(['LLMs']))
    expect(neither.missing).toEqual(['Python or Java'])
    expect(neither.score).toBe(0.5)
  })

  it('lets AWS satisfy both explicit Cloud and one provider alternative criterion', () => {
    const j = job([
      req('Cloud'),
      alternative('AWS', 'cloud-platform'),
      alternative('Azure', 'cloud-platform'),
      alternative('GCP', 'cloud-platform'),
    ])
    const m = matchJob(j, new Set(['AWS']))

    expect(m.matched).toEqual(['Cloud', 'AWS or Azure or GCP'])
    expect(m.score).toBe(1)
  })

  it('lets Golden 018 storage evidence satisfy nested broad criteria only upward', () => {
    const j = job([
      req('Data stores'),
      alternative('SQL', 'data-store-type'),
      alternative('Object Storage', 'data-store-type'),
      alternative('NoSQL', 'data-store-type'),
      alternative('PostgreSQL', 'sql-database'),
      alternative('MySQL', 'sql-database'),
    ])

    expect(matchJob(j, new Set(['PostgreSQL']))).toEqual({
      matched: ['Data stores', 'SQL or Object Storage or NoSQL', 'PostgreSQL or MySQL'],
      missing: [],
      score: 1,
    })
    expect(matchJob(j, new Set(['Data stores']))).toEqual({
      matched: ['Data stores'],
      missing: ['SQL or Object Storage or NoSQL', 'PostgreSQL or MySQL'],
      score: 1 / 3,
    })
  })
})
