// Contract tests for the JD extraction non-skill audit. No LLM, storage, or route calls.
import { describe, expect, it } from 'vitest'
import {
  NON_SKILL_CATEGORIES,
  NON_SKILL_MENTIONS_SCHEMA,
  normalizeNonSkillMentions,
} from './nonSkillContract.js'

describe('JD non-skill audit contract', () => {
  it('exposes the agreed categories and optional structured detail in the model schema', () => {
    expect(NON_SKILL_CATEGORIES).toEqual([
      'qualification',
      'experience_requirement',
      'credential',
      'soft_skill',
      'eligibility',
      'language_requirement',
      'responsibility',
    ])
    expect(NON_SKILL_MENTIONS_SCHEMA.items.properties.requirement.anyOf).toEqual([
      { type: 'string', enum: ['required', 'nice_to_have'] },
      { type: 'null' },
    ])
    expect(NON_SKILL_MENTIONS_SCHEMA.items.properties.subtype.anyOf).toEqual([
      { type: 'string', enum: ['education', 'domain_knowledge'] },
      { type: 'null' },
    ])
    expect(NON_SKILL_MENTIONS_SCHEMA.items.properties.language.type).toEqual(['string', 'null'])
    expect(NON_SKILL_MENTIONS_SCHEMA.items.properties.proficiency.type).toEqual(['string', 'null'])
    expect(NON_SKILL_MENTIONS_SCHEMA.items.additionalProperties).toBe(false)
  })

  it('preserves qualification, credential, language, and responsibility detail for persistence', () => {
    const mentions = [
      { raw_text: 'Bachelor’s degree in CS', category: 'qualification', subtype: 'education', requirement: 'required' },
      { raw_text: 'Open-source contribution', category: 'credential', requirement: 'nice_to_have' },
      { raw_text: 'German B2', category: 'language_requirement', language: 'German', proficiency: 'B2', requirement: 'nice_to_have' },
      { raw_text: 'Build the evaluation pipeline', category: 'responsibility', requirement: null },
    ]

    expect(normalizeNonSkillMentions(mentions)).toEqual(mentions)
  })

  it('uses null for unspecified language detail without dropping the language requirement', () => {
    expect(normalizeNonSkillMentions([
      { raw_text: 'Fluent in multiple languages', category: 'language_requirement', language: null, proficiency: 'fluent', requirement: 'nice_to_have' },
    ])).toEqual([
      { raw_text: 'Fluent in multiple languages', category: 'language_requirement', language: null, proficiency: 'fluent', requirement: 'nice_to_have' },
    ])
  })

  it('repairs only the unambiguous domain_knowledge shorthand', () => {
    expect(normalizeNonSkillMentions([
      { raw_text: 'Knowledge of financial services', category: 'domain_knowledge', requirement: 'required' },
      { raw_text: 'Knowledge of healthcare', category: 'domain_knowledge', subtype: 'domain_knowledge', requirement: 'nice_to_have' },
    ])).toEqual([
      { raw_text: 'Knowledge of financial services', category: 'qualification', subtype: 'domain_knowledge', requirement: 'required' },
      { raw_text: 'Knowledge of healthcare', category: 'qualification', subtype: 'domain_knowledge', requirement: 'nice_to_have' },
    ])
  })

  it('rejects malformed categories, qualification subtypes, and responsibility requirements', () => {
    expect(() => normalizeNonSkillMentions([{ raw_text: 'Degree', category: 'education', requirement: 'required' }]))
      .toThrow('unknown category education')
    expect(() => normalizeNonSkillMentions([{ raw_text: 'Degree', category: 'qualification', requirement: 'required' }]))
      .toThrow('qualification subtype must be education or domain_knowledge')
    expect(() => normalizeNonSkillMentions([{ raw_text: 'Degree', category: 'domain_knowledge', subtype: 'education', requirement: 'required' }]))
      .toThrow('domain_knowledge shorthand conflicts with subtype education')
    expect(() => normalizeNonSkillMentions([{ raw_text: 'Degree', category: 'unknown_category', requirement: 'required' }]))
      .toThrow('unknown category unknown_category')
    expect(() => normalizeNonSkillMentions([{ raw_text: 'Build it', category: 'responsibility', requirement: 'required' }]))
      .toThrow('responsibility requirement must be null')
  })
})
