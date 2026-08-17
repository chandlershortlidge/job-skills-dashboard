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
})
