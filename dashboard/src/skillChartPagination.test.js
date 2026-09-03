import { describe, expect, it } from 'vitest'
import { paginateSkillChart, SKILL_CHART_PAGE_SIZE } from './skillChartPagination'

const chart = Array.from({ length: 35 }, (_, i) => ({ skill: `skill-${i}`, count: 100 - i }))

describe('paginateSkillChart', () => {
  it('shows the first ten and advances by ten without reordering or skipping', () => {
    const first = paginateSkillChart(chart, null, 10)
    expect(first.chart).toEqual(chart.slice(0, 10))
    expect(first.nextCap).toBe(20)

    const second = paginateSkillChart(chart, null, first.nextCap)
    expect(second.chart).toEqual(chart.slice(0, 20))
    expect(second.nextCap).toBe(30)

    const third = paginateSkillChart(chart, null, second.nextCap)
    expect(third.chart).toEqual(chart.slice(0, 30))
    expect(third.nextCap).toBe(35)
    expect(SKILL_CHART_PAGE_SIZE).toBe(10)
  })

  it('clamps the final remainder and reports when no more rows remain', () => {
    const result = paginateSkillChart(chart, null, 30)
    expect(result.hasMore).toBe(true)
    expect(result.nextCap).toBe(35)

    const final = paginateSkillChart(chart, null, result.nextCap)
    expect(final.chart).toEqual(chart)
    expect(final.hasMore).toBe(false)
    expect(final.nextCap).toBe(35)
  })

  it('handles short and empty charts', () => {
    expect(paginateSkillChart(chart.slice(0, 3), null, 10)).toMatchObject({
      chart: chart.slice(0, 3),
      hasMore: false,
      nextCap: 3,
    })
    expect(paginateSkillChart([], null, 10)).toMatchObject({
      chart: [],
      hasMore: false,
      nextCap: 0,
    })
  })

  it('passes named seniority charts through by reference', () => {
    const result = paginateSkillChart(chart, 'Junior', 10)
    expect(result.chart).toBe(chart)
    expect(result.hasMore).toBe(false)
  })
})
