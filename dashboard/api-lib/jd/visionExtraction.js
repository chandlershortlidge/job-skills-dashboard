// api-lib/jd/visionExtraction.js — no-write vision extraction for one JD screenshot.
// Runs the Daytona-hosted model call and returns normalized technical skills plus the
// structured non-skill audit for the visible screenshot.
// Does NOT hash an image, deduplicate, create ids/timestamps, read/write Supabase or
// Storage, or shape an HTTP response. The calling route owns those persistence concerns.
// Invariant: every sandbox is deleted in a finally block; the returned object contains
// only model-derived job fields after deterministic normalization.

import crypto from 'node:crypto'
import { Daytona } from '@daytona/sdk'
import { NON_SKILL_MENTIONS_SCHEMA, normalizeNonSkillMentions } from './nonSkillContract.js'

export const VISION_MODEL = 'claude-sonnet-4-6'
export const VISION_MAX_TOKENS = 4096

const VISION_TOOL_STRICT = true

const USER_TEXT = 'Extract the job posting from this screenshot.'

// Plain JSON schema (no $ref) for the tool the model must call.
const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    company: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    seniority: {
      anyOf: [
        { type: 'string', enum: ['Junior', 'Mid', 'Senior'] },
        { type: 'null' },
      ],
    },
    seniority_signal: { type: ['string', 'null'] },
    seniority_basis: {
      anyOf: [
        { type: 'string', enum: ['stated', 'inferred'] },
        { type: 'null' },
      ],
    },
    summary: { type: ['string', 'null'] },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          raw_text: { type: 'string' },
          extracted_skill: { type: 'string' },
          requirement: { type: 'string', enum: ['required', 'nice_to_have'] },
          alternative_group: { type: ['string', 'null'] },
        },
        required: ['raw_text', 'extracted_skill', 'requirement', 'alternative_group'],
      },
    },
    non_skill_mentions: NON_SKILL_MENTIONS_SCHEMA,
  },
  required: ['company', 'title', 'seniority', 'seniority_signal', 'seniority_basis', 'summary', 'skills', 'non_skill_mentions'],
}

const SYSTEM_PROMPT = `You extract structured data from a SINGLE screenshot of a job posting.
The screenshots are PARTIAL: they may start or end mid-section, and the company/title
may be cropped out or shown only as a logo.

CORE RULE: BE HONEST ABOUT ABSENCE. If a field is not visible in this screenshot,
return null. Never guess or fill gaps. "not stated" beats a wrong guess.

Fields:
- company: the hiring company. May be logo-only (read the logo if you can) or cropped out -> null.
- title: the role name. If the screenshot opens mid-section with no title in frame -> null.
- seniority: one of Junior | Mid | Senior. Usually NOT stated outright -- infer it, but
  follow these ladders STRICTLY (do not freelance):
    Years:    <2yr -> Junior, 2-5yr -> Mid, 5+yr -> Senior
    Language: lead/principal/architect/deep expertise -> Senior;
              proven/production/ownership -> Mid;
              eager to learn/initial experience/strong interest -> Junior
- seniority_signal: the exact phrase or years the label keyed off.
- seniority_basis: "stated" if the posting names the level explicitly, else "inferred".
- summary: 1-2 sentences, what this role wants.
- skills: only distinct technical skills this role asks for: a language, framework,
  platform, tool, technical practice, or technical field the candidate must know or use.
  Do NOT include degrees/fields of study used as education qualifications, years or
  prior-work experience, credentials/publications, soft skills, responsibilities, or
  alternative experience paths. Keep every such visible item in non_skill_mentions.
- For each distinct skill, populate extracted_skill with one concise semantic concept label
  supported by raw_text. It is an extracted label for deterministic normalization, not the
  final canonical library identity. Do not emit a canonical field; code assigns canonical
  only after the model response.
- Extract a technical skill only when candidate-facing qualification or experience text
  asks the candidate to know, use, or have experience with it. Do not derive skills or
  requirement levels from descriptions of the role's responsibilities or future duties.
- If the same concept appears in both a responsibility and a candidate requirement, emit
  it once using the candidate requirement as raw_text. Keep the duty only in
  non_skill_mentions with category "responsibility" and requirement null.
- non_skill_mentions: each excluded item as raw_text + category + requirement. Use
  qualification (with subtype education or domain_knowledge), experience_requirement,
  credential, soft_skill, eligibility, language_requirement (with language and
  proficiency when visible), or responsibility. A responsibility always has
  requirement null; all other categories are required or nice_to_have. This is an
  audit trail, not a skills list.
- domain_knowledge is a qualification subtype, never a top-level category. Correct:
  category=qualification, subtype=domain_knowledge. Incorrect: category=domain_knowledge.
- requirement: "required" or "nice_to_have". A requirement for interest or initial
  experience in a technical topic still names a technical skill; never turn a non-skill
  into a skill merely to give it this label.
- Determine required versus nice_to_have from the section and explicit modality, not from
  words describing proficiency depth. "Familiarity" does not mean optional. In an
  unqualified required Profile or Requirements list, mark a familiarity item required
  unless wording such as "preferred", "plus", "bonus", "optional", or equivalent
  explicitly makes it nice-to-have. This applies equally to skills and non_skill_mentions.
- Keep each extracted_skill at the specificity supported by its raw text. Never add an API,
  product, or service suffix that the JD does not state: "OpenAI" is not "OpenAI API".
- The only contextual naming exception is a bare "Copilot" in an explicit AI coding-tool
  choice alongside Claude Code, Codex, or Cursor: label that product "GitHub Copilot".
  Do not use this exception to add vendor suffixes to any other bare product name.
- When a broad technical capability is followed by examples, keep the explicitly requested
  broad capability when it is independently résumé-matchable, then evaluate every example
  independently. Extract an example as its own skill only if it represents a distinct, stable,
  independently résumé-matchable technical capability, technology, framework, tool, product,
  architecture, technical practice, or named method. Example syntax such as "e.g.", "such as",
  "including", a colon, or parentheses neither qualifies nor disqualifies an item by itself.
- Do not infer a broad umbrella category that the candidate-facing text does not explicitly state.
  Do not promote examples that merely describe, decompose, or explain how the broader capability
  works, and do not promote vague descriptions, maturity evidence, or generic explanatory wording.
- "Agentic Coding Patterns (e.g., ReAct, Tool Use, Chain-of-Thought)" yields Agents and ReAct.
  ReAct is a distinct named method; Tool Use and Chain-of-Thought are explanatory components in
  this construction. If tool use or function calling is independently required elsewhere, extract
  Tool calling.
- "LLM experience (e.g. RAG, LangChain, vector databases)" yields LLMs, RAG, LangChain, and
  Vector Databases because each named example has an independent technical identity.
- Extract Fine-tuning only when candidate-facing text clearly refers to model adaptation, such as
  updating model weights, training adapters, or LoRA. Tuning or optimizing an application,
  workflow, system, or pipeline does not yield Fine-tuning.
- Provider examples such as OpenAI, Anthropic, and AWS Bedrock remain separate skills when
  they appear in candidate-facing experience requirements. Preserve their stated
  specificity: "OpenAI" remains "OpenAI"; emit "OpenAI API" only when the API is stated.
- Candidate-facing familiarity with, practical work using, or experience deploying or
  integrating AI applications via APIs yields "APIs" whenever APIs are named.
- Candidate-facing deployment requirements that explicitly name containers or
  containerization yield "Containerization", and those that explicitly name serverless
  yield "Serverless". Preserve the stated capability without inventing a concrete product
  such as Docker or AWS Lambda.
- Extract "Fine-tuning" only when candidate-facing text clearly describes adapting a model
  itself—for example, updating model weights, training adapters, LoRA, or an equivalent
  model-adaptation mechanism. First identify what is being tuned. If the object is an
  application, system, workflow, or pipeline—or model adaptation is otherwise unclear—do
  not extract "Fine-tuning", even when those literal words appear. "fine-tuning and
  evaluation of LLM pipelines" yields "Evaluation" only, not "Fine-tuning".
- Preserve explicitly requested engineering-scope capabilities alongside their named
  technologies. "Solid full-stack competence: backend (Python, Node.js) and frontend
  (React, Vue)" yields Full-stack development, Backend development, Python, Node.js,
  Frontend development, React, and Vue.
- Keep bundled awareness of governance or compliance topics in non_skill_mentions as
  qualification/domain_knowledge. "Familiarity with data & AI security, data regulations,
  data privacy requirements" does not yield a technical skill unless the JD separately
  requests hands-on implementation or operation of a named security technology or
  technical security practice.
- Within a broader alternative, concrete nested examples remain ordinary independent
  skills. "MCP, vector databases (e.g. Elasticsearch, pgvector), or AI observability
  tools" yields MCP, Vector Databases, Observability, Elasticsearch, and pgvector. Only
  MCP, Vector Databases, and Observability share the explicit alternative group;
  Elasticsearch and pgvector use null.
- When a job description explicitly requires experience building, developing, or working
  with agentic or agent-based AI systems, extract the broad technical skill "Agents"
  regardless of the exact wording used.
- Treat phrases such as "agentic systems", "AI agents", and "agent-based systems" as
  examples of this broader concept, not as an exhaustive list of trigger phrases.
- Do not collapse explicitly requested specializations into "Agents". For example, if the
  JD specifically requires "Multi-Agent Systems", preserve that as a separate skill.
- When a job description explicitly requires candidate experience with AI- or LLM-based
  applications, extract the broad technical skill "LLMs" even when the requirement is
  phrased in terms of building or working with applications.
- Preserve explicitly named AI specializations within such candidate-facing requirements:
  agents map to "Agents", and retrieval-based solutions map to "RAG". These phrases are
  examples of the broader concepts, not an exhaustive list of trigger phrases.
- Explicit candidate experience defining evaluations, tests, or quality criteria for AI
  or AI-enabled solutions maps to the technical skill "Evaluation".
- Workflow automation is independently résumé-matchable and remains separate whenever named
  in candidate-facing technical experience, including a colon list explaining broader
  AI- or LLM-application experience. Generic or hypothetical copilots and internal-
  productivity examples remain excluded. Preserve independently named specializations
  such as Agents and RAG.
- Explicit candidate-facing requirements for software-engineering skills, fundamentals,
  expertise, or a strong hands-on software-engineering background yield "Software engineering".
  Do not infer it from production-quality descriptors, responsibilities, or mere participation
  in software-engineering projects.
- Within an explicit software-engineering-fundamentals requirement, extract each separately
  named specialized capability, such as API design, data modeling, async processing, or building
  distributed systems, alongside "Software engineering".
- Do not promote quality or hygiene descriptors such as clean or maintainable code,
  comprehensive testing, performance optimization, or error handling when they only explain
  broader Python or software-engineering maturity. This contextual exclusion does not suppress
  a standalone expertise requirement.
- A dedicated candidate-facing Tech Stack section is an implicit technical requirement even
  without a "must know" verb. Extract every concrete, independently résumé-matchable technology
  it lists and mark it required unless the section explicitly makes it optional.
- Technologies mentioned only incidentally inside responsibilities or company/environment
  narrative do not become candidate skills. Keep them in responsibility audit text unless a
  candidate qualification or a dedicated Tech Stack section independently requires them.
- When a candidate requirement presents a general software-development workflow checklist, retain
  concrete tools and delivery-system capabilities with independent market signal, such as Git and
  CI/CD.
- Do not extract generic workflow practices such as issue tracking, code review, testing, or test
  automation as standalone skills when they appear only in that checklist. Do not relabel them as
  Git or CI/CD.
- This contextual exclusion does not suppress an explicit standalone requirement for testing
  expertise elsewhere.
- alternative_group: null for ordinary independent skills. For a genuine closed substitute
  choice such as "Python or Java", emit BOTH skills with the same local opaque id, e.g.
  "alt-1". Alternative grouping follows semantic substitutability, not punctuation alone.
  An illustrative list introduced by "e.g.", "such as", or "or similar" is not an
  alternative group merely because its final item uses "or"; its concrete examples remain
  independent. "LLMs, prompt engineering, or RAG" remains three independent skills.
  But when candidate-facing framework wording presents LangChain and LlamaIndex as competing
  choices, they are genuine substitutes even with example syntax: put both in one local
  alternative group. This applies to "orchestration tools (e.g., LangChain, LlamaIndex, or
  custom chaining frameworks)" and "frameworks such as LangChain, LlamaIndex, or comparable".
  Retain a meaningful broad parent such as LLM orchestration independently when it is stated.
  When a broad AI coding-tool phrase only introduces Claude Code, Codex, Cursor, and Copilot
  as interchangeable named products, omit the duplicate broad row and place those products in
  one alternative group.
  When a meaningful broad parent has closed named alternatives, retain the parent
  independently and group only the substitutable choices: "cloud platforms (GCP, AWS, or
  Azure)" yields Cloud with null plus GCP, AWS, and Azure in one group. In "Experience
  with MCP, vector databases (e.g. Elasticsearch, pgvector), or AI observability tools",
  MCP, Vector Databases, and Observability form the top-level alternative set, while
  Elasticsearch and pgvector remain independent with alternative_group null.

DISCARD UI chrome -- NOT skills: apply buttons, German UI words (Vollzeit), model-name
corner labels (gpt4), verified checkmarks, bookmark/share icons, nav.`

// Exact identity of the model-facing prompt, schema, and generation controls used by
// an evaluation run. The legacy export name remains stable for existing trace metadata.
export const VISION_PROMPT_SCHEMA_SHA256 = crypto.createHash('sha256')
  .update(JSON.stringify({
    system_prompt: SYSTEM_PROMPT,
    input_schema: INPUT_SCHEMA,
    tool_strict: VISION_TOOL_STRICT,
    max_tokens: VISION_MAX_TOKENS,
  }))
  .digest('hex')

// Redact supplied provider keys before bounding sandbox output for a response or trace.
function redactThenTruncateSandboxDetail(rawDetail, secrets) {
  let safeDetail = String(rawDetail)
  for (const secret of secrets.filter(Boolean)) safeDetail = safeDetail.replaceAll(secret, '[REDACTED]')
  return safeDetail.slice(0, 500)
}

export class VisionSandboxError extends Error {
  constructor(detail, { httpStatus = null, errorType = null } = {}) {
    // LangSmith records Error.message, so it must carry only the already-safe detail.
    super(`sandbox error: ${detail}`)
    this.name = 'VisionSandboxError'
    this.detail = detail
    this.httpStatus = httpStatus
    this.errorType = errorType
  }
}

// Recognize the sandbox's deliberately small provider-error envelope. It carries only
// selected provider fields, then redacts and caps the rendered diagnostic before tracing.
function structuredSandboxHttpError(rawDetail, secrets) {
  try {
    const envelope = JSON.parse(String(rawDetail).trim())
    if (envelope?.kind !== 'anthropic_http_error') return null
    if (!Number.isInteger(envelope.status) || envelope.status < 100 || envelope.status > 599) return null
    const errorType = typeof envelope.error_type === 'string' && /^[a-z_]{1,64}$/.test(envelope.error_type)
      ? envelope.error_type
      : null
    const errorMessage = typeof envelope.error_message === 'string' ? envelope.error_message : null
    return {
      detail: redactThenTruncateSandboxDetail(
        `Anthropic HTTP ${envelope.status}${errorType ? ` (${errorType})` : ''}${errorMessage ? `: ${errorMessage}` : ''}`,
        secrets,
      ),
      httpStatus: envelope.status,
      errorType,
    }
  } catch {
    return null
  }
}

// Infer the real content type from bytes so caller/attachment metadata cannot make a
// valid screenshot look malformed to the vision provider.
function detectImageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new TypeError('image must contain PNG, JPEG, GIF, or WebP bytes')
}

function sandboxCode(pyParams) {
  // pyParams is a double-JSON-encoded string -> a safe Python string literal.
  return `import json, urllib.error, urllib.request
P = json.loads(${pyParams})
body = {
    "model": P["model"],
    "max_tokens": P["maxTokens"],
    "system": P["system"],
    "tools": [{"name": "record_job", "description": "Record the extracted job fields. Use null for anything not visible.", "strict": P["toolStrict"], "input_schema": P["schema"]}],
    "tool_choice": {"type": "tool", "name": "record_job"},
    "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": P["mediaType"], "data": P["image"]}},
        {"type": "text", "text": P["userText"]},
    ]}],
}
req = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(body).encode(),
    headers={"x-api-key": P["apiKey"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
)
try:
    resp = json.loads(urllib.request.urlopen(req).read())
except urllib.error.HTTPError as error:
    error_type = None
    error_message = None
    try:
        error_details = json.loads(error.read().decode("utf-8")).get("error", {})
        error_type = error_details.get("type")
        error_message = error_details.get("message")
    except Exception:
        pass
    print(json.dumps({"kind": "anthropic_http_error", "status": error.code, "error_type": error_type, "error_message": error_message}))
    raise SystemExit(1)
out = None
for block in resp.get("content", []):
    if block.get("type") == "tool_use":
        out = block["input"]
        break
print(json.dumps({
    "response_id": resp.get("id"),
    "stop_reason": resp.get("stop_reason"),
    "usage": resp.get("usage"),
    "tool_input": out,
}))`
}

const VISION_FIELDS = Object.freeze([
  'company',
  'title',
  'seniority',
  'seniority_signal',
  'seniority_basis',
  'summary',
  'skills',
  'non_skill_mentions',
])

function invalidVisionPayload(message) {
  throw new TypeError(`invalid vision extraction: ${message}`)
}

function validateNullableString(value, field) {
  if (value !== null && typeof value !== 'string') invalidVisionPayload(`${field} must be a string or null`)
}

// Reject provider/schema failures before permissive downstream normalizers can turn them
// into empty successful output. Strict tool use prevents ordinary schema drift; this is
// the runtime defense for truncated, refused, or otherwise invalid provider responses.
export function validateVisionExtractionPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidVisionPayload('payload must be an object')
  for (const field of VISION_FIELDS) {
    if (!Object.hasOwn(parsed, field)) invalidVisionPayload(`${field} is required`)
  }
  for (const field of Object.keys(parsed)) {
    if (!VISION_FIELDS.includes(field)) invalidVisionPayload(`unknown field ${field}`)
  }

  validateNullableString(parsed.company, 'company')
  validateNullableString(parsed.title, 'title')
  validateNullableString(parsed.seniority_signal, 'seniority_signal')
  validateNullableString(parsed.summary, 'summary')
  if (![null, 'Junior', 'Mid', 'Senior'].includes(parsed.seniority)) {
    invalidVisionPayload('seniority must be Junior, Mid, Senior, or null')
  }
  if (![null, 'stated', 'inferred'].includes(parsed.seniority_basis)) {
    invalidVisionPayload('seniority_basis must be stated, inferred, or null')
  }
  if (!Array.isArray(parsed.skills)) invalidVisionPayload('skills must be an array')
  if (!Array.isArray(parsed.non_skill_mentions)) invalidVisionPayload('non_skill_mentions must be an array')

  const skillFields = ['raw_text', 'extracted_skill', 'requirement', 'alternative_group']
  for (const [index, skill] of parsed.skills.entries()) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) invalidVisionPayload(`skills[${index}] must be an object`)
    for (const field of skillFields) {
      if (!Object.hasOwn(skill, field)) invalidVisionPayload(`skills[${index}].${field} is required`)
    }
    for (const field of Object.keys(skill)) {
      if (!skillFields.includes(field)) invalidVisionPayload(`skills[${index}] has unknown field ${field}`)
    }
    if (typeof skill.raw_text !== 'string' || !skill.raw_text.trim()) {
      invalidVisionPayload(`skills[${index}].raw_text must be a non-empty string`)
    }
    if (typeof skill.extracted_skill !== 'string' || !skill.extracted_skill.trim()) {
      invalidVisionPayload(`skills[${index}].extracted_skill must be a non-empty string`)
    }
    if (!['required', 'nice_to_have'].includes(skill.requirement)) {
      invalidVisionPayload(`skills[${index}].requirement must be required or nice_to_have`)
    }
    if (skill.alternative_group !== null && typeof skill.alternative_group !== 'string') {
      invalidVisionPayload(`skills[${index}].alternative_group must be a string or null`)
    }
  }
  return parsed
}

// Apply the route's injected technical normalizer without adding route-owned fields.
export function shapeVisionExtraction(parsed, normalizeTechnicalSkills) {
  const validated = validateVisionExtractionPayload(parsed)
  return {
    ...validated,
    skills: normalizeTechnicalSkills(validated.skills),
    non_skill_mentions: normalizeNonSkillMentions(validated.non_skill_mentions),
  }
}

const USAGE_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
])

function allowlistedModelMetadata(envelope) {
  const usage = {}
  for (const field of USAGE_FIELDS) {
    const value = envelope?.usage?.[field]
    if (Number.isInteger(value) && value >= 0) usage[field] = value
  }
  return Object.freeze({
    response_id: typeof envelope?.response_id === 'string' ? envelope.response_id : null,
    stop_reason: typeof envelope?.stop_reason === 'string' ? envelope.stop_reason : null,
    usage: Object.freeze(usage),
  })
}

function toolInputFromEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    invalidVisionPayload('provider response envelope must be an object')
  }
  if (envelope.stop_reason === 'max_tokens') {
    throw new VisionSandboxError('Anthropic stopped before a complete extraction: max_tokens')
  }
  if (envelope.stop_reason === 'refusal') {
    throw new VisionSandboxError('Anthropic refused the extraction')
  }
  if (envelope.stop_reason !== 'tool_use') {
    throw new VisionSandboxError(`Anthropic did not complete the required tool: ${String(envelope.stop_reason)}`)
  }
  if (!envelope.tool_input || typeof envelope.tool_input !== 'object' || Array.isArray(envelope.tool_input)) {
    invalidVisionPayload('tool input is required')
  }
  return envelope.tool_input
}

// Run one image through the vision model and return only its normalized extraction.
export async function runVisionExtraction({
  image,
  daytonaApiKey,
  anthropicApiKey,
  normalizeTechnicalSkills,
  onModelMetadata = null,
  daytonaFactory = (apiKey) => new Daytona({ apiKey }),
}) {
  if (onModelMetadata !== null && typeof onModelMetadata !== 'function') {
    throw new TypeError('onModelMetadata must be a function or null')
  }
  const params = JSON.stringify({
    apiKey: anthropicApiKey,
    model: VISION_MODEL,
    maxTokens: VISION_MAX_TOKENS,
    toolStrict: VISION_TOOL_STRICT,
    system: SYSTEM_PROMPT,
    userText: USER_TEXT,
    schema: INPUT_SCHEMA,
    image,
    mediaType: detectImageMediaType(Buffer.from(image, 'base64')),
  })
  const pyParams = JSON.stringify(params)

  let sandbox
  try {
    const daytona = daytonaFactory(daytonaApiKey)
    // Ephemeral + short auto-stop prevents leaked sandboxes from consuming Daytona disk.
    sandbox = await daytona.create({ language: 'python', ephemeral: true, autoStopInterval: 2 })
    const result = await sandbox.process.codeRun(sandboxCode(pyParams))
    if (result.exitCode !== 0) {
      const diagnosis = structuredSandboxHttpError(result.result, [anthropicApiKey, daytonaApiKey])
      if (diagnosis) throw new VisionSandboxError(diagnosis.detail, diagnosis)
      throw new VisionSandboxError(redactThenTruncateSandboxDetail(result.result, [anthropicApiKey, daytonaApiKey]))
    }
    const envelope = JSON.parse(String(result.result).trim())
    const metadata = allowlistedModelMetadata(envelope)
    if (onModelMetadata) onModelMetadata(metadata)
    const toolInput = toolInputFromEnvelope(envelope)
    return shapeVisionExtraction(toolInput, normalizeTechnicalSkills)
  } finally {
    if (sandbox) {
      try { await sandbox.delete() } catch { /* best effort */ }
    }
  }
}
