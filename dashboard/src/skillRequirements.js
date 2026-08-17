/**
 * Convert extracted job-skill rows into human and matcher-facing requirements.
 *
 * This module groups explicit alternatives such as “Python or Java” into one
 * requirement while leaving ordinary skills independent. It does not decide
 * whether a mention is a skill, normalize a canonical name, or aggregate chart
 * frequency; those belong to extraction and normalization.
 */

function groupKey(skill) {
  return skill.alternative_group ? `${skill.requirement}\u0000${skill.alternative_group}` : null
}

// Produce stable requirement objects in source order. Each object has a display label
// and the canonicals that can satisfy it. A standalone canonical is deduped; grouped
// members remain together so either member can satisfy the one criterion.
export function skillRequirements(skills, { requiredOnly = false } = {}) {
  const out = []
  const standalone = new Set()
  const groups = new Map()

  for (const skill of skills || []) {
    if (!skill?.canonical || (requiredOnly && skill.requirement !== 'required')) continue
    const key = groupKey(skill)
    if (!key) {
      const singleKey = `${skill.requirement}\u0000${skill.canonical}`
      if (standalone.has(singleKey)) continue
      standalone.add(singleKey)
      out.push({ label: skill.canonical, options: [skill.canonical], requirement: skill.requirement })
      continue
    }

    let group = groups.get(key)
    if (!group) {
      group = { label: '', options: [], requirement: skill.requirement }
      groups.set(key, group)
      out.push(group)
    }
    if (!group.options.includes(skill.canonical)) group.options.push(skill.canonical)
    group.label = group.options.join(' or ')
  }

  return out
}

export function requiredSkillRequirements(skills) {
  return skillRequirements(skills, { requiredOnly: true })
}
