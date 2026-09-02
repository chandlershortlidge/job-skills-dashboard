// Tests for the no-write vision-extraction target. Daytona is injected and mocked;
// no LLM, database, Storage, or HTTP route is called.
import { describe, expect, it, vi } from 'vitest'
import {
  runVisionExtraction,
  VisionSandboxError,
  VISION_MAX_TOKENS,
  VISION_PROMPT_SCHEMA_SHA256,
} from './visionExtraction.js'

const PARSED = {
  company: 'Acme AI',
  title: 'AI Engineer',
  seniority: 'Mid',
  seniority_signal: '2-5 years',
  seniority_basis: 'inferred',
  summary: 'Builds LLM features.',
  skills: [{ raw_text: 'large language models', extracted_skill: 'large language models', requirement: 'required', alternative_group: null }],
  non_skill_mentions: [{ raw_text: 'German B2', category: 'language_requirement', language: 'German', proficiency: 'B2', requirement: 'nice_to_have' }],
}

const PNG_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const WEBP_IMAGE = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]).toString('base64')

function providerEnvelope(toolInput = PARSED, overrides = {}) {
  return {
    response_id: 'msg_test_123',
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 200 },
    tool_input: toolInput,
    ...overrides,
  }
}

function sandboxParams(code) {
  const match = code.match(/^P = json\.loads\((.+)\)$/m)
  if (!match) throw new Error('sandbox parameters were not embedded')
  return JSON.parse(JSON.parse(match[1]))
}

function fakeDaytona({ result = JSON.stringify(providerEnvelope()), exitCode = 0 } = {}) {
  const sandbox = {
    process: { codeRun: vi.fn(async () => ({ exitCode, result })) },
    delete: vi.fn(async () => {}),
  }
  return { factory: vi.fn(() => ({ create: vi.fn(async () => sandbox) })), sandbox }
}

function input(overrides = {}) {
  return {
    image: PNG_IMAGE,
    mediaType: 'image/png',
    daytonaApiKey: 'daytona-test-key',
    anthropicApiKey: 'anthropic-test-key',
    normalizeTechnicalSkills: vi.fn((skills) => skills.map(({ extracted_skill, ...skill }) => ({
      ...skill,
      canonical: extracted_skill === 'large language models' ? 'LLMs' : extracted_skill,
    }))),
    ...overrides,
  }
}

describe('runVisionExtraction', () => {
  it('exports a SHA-256 fingerprint for the exact model prompt and schema', () => {
    expect(VISION_PROMPT_SCHEMA_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(VISION_MAX_TOKENS).toBe(4096)
  })

  it('forwards the image to Daytona, normalizes the model result, and deletes the sandbox', async () => {
    const { factory, sandbox } = fakeDaytona()
    const args = input({ daytonaFactory: factory })
    const result = await runVisionExtraction(args)

    expect(factory).toHaveBeenCalledWith('daytona-test-key')
    expect(sandbox.process.codeRun).toHaveBeenCalledOnce()
    const code = sandbox.process.codeRun.mock.calls[0][0]
    const params = sandboxParams(code)
    expect(code).toContain(args.image)
    expect(code).toContain('"max_tokens": P["maxTokens"]')
    expect(code).toContain('"strict": P["toolStrict"]')
    expect(params.maxTokens).toBe(4096)
    expect(params.toolStrict).toBe(true)
    expect(params.schema.additionalProperties).toBe(false)
    expect(params.schema.properties.skills.items.additionalProperties).toBe(false)
    expect(params.schema.properties.seniority.anyOf).toEqual([
      { type: 'string', enum: ['Junior', 'Mid', 'Senior'] },
      { type: 'null' },
    ])
    expect(params.schema.properties.seniority_basis.anyOf).toEqual([
      { type: 'string', enum: ['stated', 'inferred'] },
      { type: 'null' },
    ])
    expect(args.normalizeTechnicalSkills).toHaveBeenCalledWith(PARSED.skills)
    expect(result).toEqual({
      ...PARSED,
      skills: [{
        raw_text: 'large language models',
        canonical: 'LLMs',
        requirement: 'required',
        alternative_group: null,
      }],
    })
    expect(result.skills[0]).not.toHaveProperty('extracted_skill')
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('screenshot_path')
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('reports only allowlisted provider metadata without changing the returned job', async () => {
    const onModelMetadata = vi.fn()
    const { factory } = fakeDaytona({
      result: JSON.stringify(providerEnvelope(PARSED, {
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          secret_future_field: 'do not expose',
        },
        secret_envelope_field: 'do not expose',
      })),
    })

    const result = await runVisionExtraction(input({ daytonaFactory: factory, onModelMetadata }))

    expect(onModelMetadata).toHaveBeenCalledWith({
      response_id: 'msg_test_123',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
    })
    expect(result).not.toHaveProperty('response_id')
    expect(result).not.toHaveProperty('stop_reason')
    expect(result).not.toHaveProperty('usage')
  })

  it('returns an extraction when the model uses the domain_knowledge shorthand', async () => {
    const parsed = structuredClone(PARSED)
    parsed.non_skill_mentions = [{
      raw_text: 'Knowledge of financial services',
      category: 'domain_knowledge',
      requirement: 'required',
    }]
    const { factory, sandbox } = fakeDaytona({ result: JSON.stringify(providerEnvelope(parsed)) })

    await expect(runVisionExtraction(input({ daytonaFactory: factory }))).resolves.toMatchObject({
      non_skill_mentions: [{
        raw_text: 'Knowledge of financial services',
        category: 'qualification',
        subtype: 'domain_knowledge',
        requirement: 'required',
      }],
    })
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing skills', (() => { const parsed = structuredClone(PARSED); delete parsed.skills; return parsed })(), 'skills is required'],
    ['missing non-skill audit', (() => { const parsed = structuredClone(PARSED); delete parsed.non_skill_mentions; return parsed })(), 'non_skill_mentions is required'],
    ['malformed skill', { ...structuredClone(PARSED), skills: [{ ...PARSED.skills[0], extracted_skill: '' }] }, 'skills[0].extracted_skill must be a non-empty string'],
  ])('rejects %s before normalization and cleans up', async (_name, parsed, message) => {
    const { factory, sandbox } = fakeDaytona({ result: JSON.stringify(providerEnvelope(parsed)) })
    const args = input({ daytonaFactory: factory })

    await expect(runVisionExtraction(args)).rejects.toThrow(message)
    expect(args.normalizeTechnicalSkills).not.toHaveBeenCalled()
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it.each([
    ['max_tokens', 'Anthropic stopped before a complete extraction: max_tokens'],
    ['refusal', 'Anthropic refused the extraction'],
    ['end_turn', 'Anthropic did not complete the required tool: end_turn'],
  ])('rejects provider stop reason %s, reports metadata, and cleans up', async (stopReason, message) => {
    const onModelMetadata = vi.fn()
    const { factory, sandbox } = fakeDaytona({
      result: JSON.stringify(providerEnvelope(null, { stop_reason: stopReason })),
    })

    await expect(runVisionExtraction(input({ daytonaFactory: factory, onModelMetadata }))).rejects.toThrow(message)
    expect(onModelMetadata).toHaveBeenCalledWith(expect.objectContaining({ stop_reason: stopReason }))
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('rejects a missing tool input before normalization and cleans up', async () => {
    const { factory, sandbox } = fakeDaytona({ result: JSON.stringify(providerEnvelope(null)) })
    const args = input({ daytonaFactory: factory })

    await expect(runVisionExtraction(args)).rejects.toThrow('tool input is required')
    expect(args.normalizeTechnicalSkills).not.toHaveBeenCalled()
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('uses the image bytes instead of a caller-supplied MIME label', async () => {
    const { factory, sandbox } = fakeDaytona()
    const args = input({ image: WEBP_IMAGE, mediaType: 'image/png', daytonaFactory: factory })

    await runVisionExtraction(args)

    const code = sandbox.process.codeRun.mock.calls[0][0]
    expect(code).toContain(WEBP_IMAGE)
    expect(code).toContain('image/webp')
    expect(code).not.toContain('image/png')
  })

  it('rejects unknown image bytes before creating a sandbox', async () => {
    const { factory } = fakeDaytona()

    await expect(runVisionExtraction(input({
      image: Buffer.from('not-an-image').toString('base64'),
      daytonaFactory: factory,
    }))).rejects.toThrow('image must contain PNG, JPEG, GIF, or WebP bytes')

    expect(factory).not.toHaveBeenCalled()
  })

  it('redacts both provider keys while preserving a sandbox diagnostic after cleanup', async () => {
    const rawDetail = 'HTTP 429: anthropic-test-key rejected while daytona-test-key created the sandbox'
    const { factory, sandbox } = fakeDaytona({ result: rawDetail, exitCode: 1 })

    let error
    try {
      await runVisionExtraction(input({ daytonaFactory: factory }))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(VisionSandboxError)
    expect(error.detail).toContain('HTTP 429')
    expect(error.message).toContain('HTTP 429')
    expect(error.detail).not.toContain('anthropic-test-key')
    expect(error.detail).not.toContain('daytona-test-key')
    expect(error.message).not.toContain('anthropic-test-key')
    expect(error.message).not.toContain('daytona-test-key')
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('surfaces a redacted, capped Anthropic HTTP reason before tracing', async () => {
    const longMessage = `${'x'.repeat(460)}anthropic-test-key`
    const { factory, sandbox } = fakeDaytona({
      result: JSON.stringify({
        kind: 'anthropic_http_error',
        status: 400,
        error_type: 'invalid_request_error',
        error_message: longMessage,
      }),
      exitCode: 1,
    })

    let error
    try {
      await runVisionExtraction(input({ daytonaFactory: factory }))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(VisionSandboxError)
    expect(error.detail).toHaveLength(500)
    expect(error.detail).toContain('Anthropic HTTP 400 (invalid_request_error): ')
    expect(error.detail).not.toContain('anthropic-test-key')
    expect(error.message).not.toContain('anthropic-test-key')
    expect(error.httpStatus).toBe(400)
    expect(error.errorType).toBe('invalid_request_error')
    expect(sandbox.process.codeRun.mock.calls[0][0]).toContain('except urllib.error.HTTPError as error:')
    expect(sandbox.process.codeRun.mock.calls[0][0]).toContain('"error_message"')
    expect(sandbox.process.codeRun.mock.calls[0][0]).toContain('"anthropic_http_error"')
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('redacts a key before the 500-character detail limit can expose its prefix', async () => {
    const rawDetail = `HTTP 429 ${'x'.repeat(481)}anthropic-test-key`
    const { factory, sandbox } = fakeDaytona({ result: rawDetail, exitCode: 1 })

    let error
    try {
      await runVisionExtraction(input({ daytonaFactory: factory }))
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(VisionSandboxError)
    expect(error.detail).toHaveLength(500)
    expect(error.detail).toContain('HTTP 429')
    expect(error.detail).not.toContain('anthropic-')
    expect(error.message).not.toContain('anthropic-')
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })

  it('rejects non-JSON model output after cleanup', async () => {
    const { factory, sandbox } = fakeDaytona({ result: 'not json' })

    await expect(runVisionExtraction(input({ daytonaFactory: factory }))).rejects.toThrow(SyntaxError)
    expect(sandbox.delete).toHaveBeenCalledOnce()
  })
})
