// api-lib/jd/scoreExtraction.js — deterministic comparison for JD extraction evals.
// Scores a live `{skills, non_skill_mentions}` result against a golden
// `{technical_skills, non_skill_mentions}` reference.
// Does NOT call an LLM, normalize skill names, write data, or decide the golden truth.
// Invariant: technical alternatives are compared as a single choice-set regardless of
// their group label; audit mentions match one-to-one on normalized source text.

export const REPORTED_NON_SKILL_CATEGORIES = Object.freeze([
  'qualification',
  'experience_requirement',
  'soft_skill',
  'eligibility',
  'language_requirement',
  'responsibility',
])

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizedText(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator
}

function matchingTechnicalPairs(actualSkills, expectedSkills) {
  const unusedActual = new Set(actualSkills.map((_, index) => index))
  const pairs = []

  for (const expected of expectedSkills) {
    const candidates = [...unusedActual].filter((index) => actualSkills[index].canonical === expected.canonical)
    const index = candidates.find((candidate) => actualSkills[candidate].requirement === expected.requirement) ?? candidates[0]
    if (index === undefined) continue
    unusedActual.delete(index)
    pairs.push({ actual: actualSkills[index], expected })
  }

  return pairs
}

function alternativeChoiceSets(skills) {
  const choicesByGroup = new Map()
  for (const skill of skills) {
    if (skill.alternative_group == null) continue
    const choices = choicesByGroup.get(skill.alternative_group) ?? []
    choices.push(skill.canonical)
    choicesByGroup.set(skill.alternative_group, choices)
  }
  return new Set([...choicesByGroup.values()].map((choices) => [...choices].sort().join('|')))
}

function sameAuditStructure(actual, expected) {
  return actual.category === expected.category
    && actual.requirement === expected.requirement
    && (actual.subtype ?? null) === (expected.subtype ?? null)
    && (actual.language ?? null) === (expected.language ?? null)
    && (actual.proficiency ?? null) === (expected.proficiency ?? null)
}

function matchingAuditPairs(actualMentions, expectedMentions) {
  const expectedByText = new Map()
  for (const [index, expected] of expectedMentions.entries()) {
    const key = normalizedText(expected.raw_text)
    const indices = expectedByText.get(key) ?? []
    indices.push(index)
    expectedByText.set(key, indices)
  }

  const unusedExpected = new Set(expectedMentions.map((_, index) => index))
  const pairs = []
  for (const actual of actualMentions) {
    const candidates = (expectedByText.get(normalizedText(actual.raw_text)) ?? [])
      .filter((index) => unusedExpected.has(index))
    const index = candidates.find((candidate) => sameAuditStructure(actual, expectedMentions[candidate])) ?? candidates[0]
    if (index === undefined) continue
    unusedExpected.delete(index)
    pairs.push({ actual, expected: expectedMentions[index] })
  }

  return pairs
}

// Count category-specific source-text matches without changing the shared one-to-one matching policy.
function auditCategoryScores(actualMentions, expectedMentions, auditPairs) {
  return Object.fromEntries(REPORTED_NON_SKILL_CATEGORIES.map((category) => {
    const expected = expectedMentions.filter((mention) => mention.category === category).length
    const predicted = actualMentions.filter((mention) => mention.category === category).length
    const matched = auditPairs.filter((pair) => (
      pair.actual.category === category && pair.expected.category === category
    )).length

    return [category, {
      expected,
      predicted,
      matched,
      precision: predicted === 0 ? null : matched / predicted,
      recall: expected === 0 ? null : matched / expected,
    }]
  }))
}

// Compare one model result with one golden reference without making semantic judgments.
export function scoreExtraction(actualResult, expectedExtraction) {
  const actualSkills = asArray(actualResult?.skills)
  const expectedSkills = asArray(expectedExtraction?.technical_skills)
  const technicalPairs = matchingTechnicalPairs(actualSkills, expectedSkills)
  const requirementMatches = technicalPairs.filter(({ actual, expected }) => actual.requirement === expected.requirement)

  const expectedGroups = alternativeChoiceSets(expectedSkills)
  const actualGroups = alternativeChoiceSets(actualSkills)
  const matchedGroups = [...expectedGroups].filter((group) => actualGroups.has(group))

  const actualAudit = asArray(actualResult?.non_skill_mentions)
  const expectedAudit = asArray(expectedExtraction?.non_skill_mentions)
  const auditPairs = matchingAuditPairs(actualAudit, expectedAudit)
  const categoryMatches = auditPairs.filter(({ actual, expected }) => actual.category === expected.category)
  const structuredMatches = auditPairs.filter(({ actual, expected }) => sameAuditStructure(actual, expected))

  return {
    technical: {
      expected: expectedSkills.length,
      actual: actualSkills.length,
      canonical_precision: ratio(technicalPairs.length, actualSkills.length),
      canonical_recall: ratio(technicalPairs.length, expectedSkills.length),
      requirement_accuracy: ratio(requirementMatches.length, technicalPairs.length),
      alternative_group_accuracy: ratio(matchedGroups.length, expectedGroups.size),
      expected_alternative_groups: expectedGroups.size,
      actual_alternative_groups: actualGroups.size,
    },
    audit: {
      expected: expectedAudit.length,
      actual: actualAudit.length,
      non_skill_precision: ratio(auditPairs.length, actualAudit.length),
      non_skill_recall: ratio(auditPairs.length, expectedAudit.length),
      category_label_accuracy: ratio(categoryMatches.length, expectedAudit.length),
      structured_accuracy: ratio(structuredMatches.length, expectedAudit.length),
      by_category: auditCategoryScores(actualAudit, expectedAudit, auditPairs),
    },
  }
}
