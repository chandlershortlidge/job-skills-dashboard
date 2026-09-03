/**
 * Applies presentation-only pagination to the ranked skills chart.
 * It does not filter, rank, or mutate the input array, and named seniority
 * views always receive the original array by reference.
 */
export const SKILL_CHART_PAGE_SIZE = 10

export function paginateSkillChart(chart, selectedSeniority, visibleCap) {
  if (selectedSeniority !== null) {
    return { chart, hasMore: false, nextCap: visibleCap }
  }

  const cap = Math.max(
    SKILL_CHART_PAGE_SIZE,
    Number.isFinite(visibleCap) ? visibleCap : SKILL_CHART_PAGE_SIZE,
  )
  const shown = chart.slice(0, cap)
  return {
    chart: shown,
    hasMore: shown.length < chart.length,
    nextCap: Math.min(cap + SKILL_CHART_PAGE_SIZE, chart.length),
  }
}
