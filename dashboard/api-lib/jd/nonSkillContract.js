// api-lib/jd/nonSkillContract.js — shared contract for the JD extraction audit.
// Defines and normalizes the structured non-skill mentions returned by the vision model.
// Does NOT classify text, call an LLM, read/write storage, or alter technical skills.
// Invariant: every returned mention uses the agreed target category; qualifications have
// a subtype, language requirements retain language/proficiency fields, and only a
// responsibility may have a null requirement.

export const NON_SKILL_CATEGORIES = Object.freeze([
  'qualification',
  'experience_requirement',
  'credential',
  'soft_skill',
  'eligibility',
  'language_requirement',
  'responsibility',
])

export const QUALIFICATION_SUBTYPES = Object.freeze(['education', 'domain_knowledge'])

const REQUIREMENTS = new Set(['required', 'nice_to_have'])

export const NON_SKILL_MENTIONS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      raw_text: { type: 'string' },
      category: { type: 'string', enum: NON_SKILL_CATEGORIES },
      requirement: {
        anyOf: [
          { type: 'string', enum: ['required', 'nice_to_have'] },
          { type: 'null' },
        ],
      },
      subtype: {
        anyOf: [
          { type: 'string', enum: ['education', 'domain_knowledge'] },
          { type: 'null' },
        ],
      },
      language: { type: ['string', 'null'] },
      proficiency: { type: ['string', 'null'] },
    },
    required: ['raw_text', 'category', 'requirement'],
  },
}

function invalid(message) {
  throw new TypeError(`invalid non-skill mention: ${message}`)
}

// Repair the model's unambiguous legacy shorthand without accepting conflicting detail.
function repairDomainKnowledgeShorthand(mention) {
  if (mention?.category !== 'domain_knowledge') return mention
  if (![undefined, null, 'domain_knowledge'].includes(mention.subtype)) {
    invalid(`domain_knowledge shorthand conflicts with subtype ${String(mention.subtype)}`)
  }
  return { ...mention, category: 'qualification', subtype: 'domain_knowledge' }
}

// Return a persistence-safe copy of the model audit, preserving category-specific detail.
export function normalizeNonSkillMentions(mentions) {
  if (!Array.isArray(mentions)) return []

  return mentions.map((originalMention) => {
    const mention = repairDomainKnowledgeShorthand(originalMention)
    const { raw_text, category, requirement } = mention ?? {}
    if (typeof raw_text !== 'string' || !raw_text) invalid('raw_text must be a non-empty string')
    if (!NON_SKILL_CATEGORIES.includes(category)) invalid(`unknown category ${String(category)}`)
    if (category === 'responsibility') {
      if (requirement !== null) invalid('responsibility requirement must be null')
      return { raw_text, category, requirement }
    }
    if (!REQUIREMENTS.has(requirement)) invalid(`${category} requirement must be required or nice_to_have`)

    const normalized = { raw_text, category, requirement }
    if (category === 'qualification') {
      if (!QUALIFICATION_SUBTYPES.includes(mention.subtype)) invalid('qualification subtype must be education or domain_knowledge')
      normalized.subtype = mention.subtype
    }
    if (category === 'language_requirement') {
      normalized.language = mention.language ?? null
      normalized.proficiency = mention.proficiency ?? null
    }
    return normalized
  })
}
