// Tests for deterministic JD extraction scoring. Uses real committed golden references;
// no LLM, storage, database, or LangSmith calls are made.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scoreExtraction } from './scoreExtraction.js'

const micro1 = JSON.parse(readFileSync(new URL('../../../evals/golden_017.jsonl', import.meta.url), 'utf8'))
const artefact = JSON.parse(readFileSync(new URL('../../../evals/golden_001.jsonl', import.meta.url), 'utf8'))
const cognee = JSON.parse(readFileSync(new URL('../../../evals/golden_002.jsonl', import.meta.url), 'utf8'))
const mercanis = JSON.parse(readFileSync(new URL('../../../evals/golden_003.jsonl', import.meta.url), 'utf8'))
const digitalCharging = JSON.parse(readFileSync(new URL('../../../evals/golden_004.jsonl', import.meta.url), 'utf8'))
const smartbroker = JSON.parse(readFileSync(new URL('../../../evals/golden_005.jsonl', import.meta.url), 'utf8'))
const unity = JSON.parse(readFileSync(new URL('../../../evals/golden_006.jsonl', import.meta.url), 'utf8'))
const waveSix = JSON.parse(readFileSync(new URL('../../../evals/golden_007.jsonl', import.meta.url), 'utf8'))
const ellamind = JSON.parse(readFileSync(new URL('../../../evals/golden_008.jsonl', import.meta.url), 'utf8'))
const reedsy = JSON.parse(readFileSync(new URL('../../../evals/golden_009.jsonl', import.meta.url), 'utf8'))
const techstaff = JSON.parse(readFileSync(new URL('../../../evals/golden_011.jsonl', import.meta.url), 'utf8'))
const sparetech = JSON.parse(readFileSync(new URL('../../../evals/golden_012.jsonl', import.meta.url), 'utf8'))
const dexterHealth = JSON.parse(readFileSync(new URL('../../../evals/golden_013.jsonl', import.meta.url), 'utf8'))
const iu = JSON.parse(readFileSync(new URL('../../../evals/golden_014.jsonl', import.meta.url), 'utf8'))
const lufinity = JSON.parse(readFileSync(new URL('../../../evals/golden_015.jsonl', import.meta.url), 'utf8'))
const netconomy = JSON.parse(readFileSync(new URL('../../../evals/golden_016.jsonl', import.meta.url), 'utf8'))
const quantori = JSON.parse(readFileSync(new URL('../../../evals/golden_018.jsonl', import.meta.url), 'utf8'))
const tryHackMe = JSON.parse(readFileSync(new URL('../../../evals/golden_019.jsonl', import.meta.url), 'utf8'))
const zdfSparks = JSON.parse(readFileSync(new URL('../../../evals/golden_020.jsonl', import.meta.url), 'utf8'))
const expected = micro1.expected_extraction

function exactResult() {
  return {
    skills: expected.technical_skills.map((skill) => ({ ...skill })),
    non_skill_mentions: expected.non_skill_mentions.map((mention) => ({ ...mention })),
  }
}

describe('scoreExtraction', () => {
  it('keeps Mercanis Agents and Multi-Agent Systems as separate expected skills', () => {
    expect(mercanis.expected_extraction.technical_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Agents', requirement: 'required', alternative_group: null }),
      expect.objectContaining({ canonical: 'Multi-Agent Systems', requirement: 'nice_to_have', alternative_group: null }),
    ]))
  })

  it('keeps Cognee SDKs and AI Infrastructure as technical skills, not audit qualifications', () => {
    const technical = cognee.expected_extraction.technical_skills
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'SDKs', requirement: 'required' }),
      expect.objectContaining({ canonical: 'AI Infrastructure', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Git', requirement: 'required' }),
      expect.objectContaining({ canonical: 'OpenAI API', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'Anthropic API', requirement: 'nice_to_have' }),
    ]))
    expect(cognee.expected_extraction.non_skill_mentions)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ raw_text: 'AI infrastructure' })]))
  })

  it('keeps Golden 004 candidate skills while omitting generic workflow practices', () => {
    const technical = digitalCharging.expected_extraction.technical_skills
    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Software engineering',
      'LLMs',
      'workflow automation',
      'Agents',
      'RAG',
      'APIs',
      'Evaluation',
      'Git',
      'CI/CD',
    ])
    expect(technical.find((skill) => skill.canonical === 'Software engineering'))
      .toEqual(expect.objectContaining({
        raw_text: expect.stringContaining('Strong hands-on software engineering background'),
        requirement: 'required',
      }))
    for (const canonical of ['LLMs', 'Agents', 'RAG']) {
      expect(technical.find((skill) => skill.canonical === canonical))
        .toEqual(expect.objectContaining({ raw_text: expect.stringContaining('Practical experience') }))
    }
    expect(technical.find((skill) => skill.canonical === 'Evaluation'))
      .toEqual(expect.objectContaining({ raw_text: expect.stringContaining('Experience defining') }))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Issue Tracking' }),
      expect.objectContaining({ canonical: 'Code Review' }),
      expect.objectContaining({ canonical: 'Test Automation' }),
    ]))
  })

  it('keeps every named Golden 005 tool at the visible specificity', () => {
    const visibleTools = 'related technical tools (OpenAI, LangChain, Langfuse …)'
    const technical = smartbroker.expected_extraction.technical_skills

    expect(smartbroker.job_description).toContain(visibleTools)
    for (const canonical of ['OpenAI', 'LangChain', 'Langfuse']) {
      expect(technical).toEqual(expect.arrayContaining([expect.objectContaining({
        raw_text: visibleTools,
        canonical,
        requirement: 'required',
      })]))
    }
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'LlamaIndex' }),
      expect.objectContaining({ canonical: 'OpenAI API' }),
    ]))
    // Golden 005 predates the later global policies for explicit software-engineering
    // requirements and version-control workflow skills; keep those corrections locked.
    expect(technical).toHaveLength(16)
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonical: 'Software engineering',
        raw_text: expect.stringContaining('Deep knowledge of software engineering best practices'),
        requirement: 'required',
        alternative_group: null,
      }),
      expect.objectContaining({
        canonical: 'Git',
        raw_text: 'version control',
        requirement: 'required',
        alternative_group: null,
      }),
    ]))
    expect(smartbroker.expected_extraction.non_skill_mentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        raw_text: 'Familiarity with data & AI security, data regulations, data privacy requirements',
        category: 'qualification',
        subtype: 'domain_knowledge',
        requirement: 'required',
      }),
    ]))
  })

  it('keeps Golden 006 Agents and named ReAct while excluding explanatory pattern components', () => {
    const illustrativePatterns = 'Agentic Coding Patterns (e.g., ReAct, Tool Use, Chain-of-Thought)'
    const pipelineWork = 'Several years of practical experience in the design and operation of productive AI systems, including RAG architectures, fine-tuning and evaluation of LLM pipelines'
    const vectorDatabaseExamples = 'Experience with MCP (Model Context Protocol), vector databases (e.g. Elasticsearch, pgvector, etc.) or AI observability tools'
    const technical = unity.expected_extraction.technical_skills
    const skillsFromPattern = technical.filter((skill) => skill.raw_text === illustrativePatterns)
    const skillsFromVectorDatabaseList = technical.filter((skill) => skill.raw_text === vectorDatabaseExamples)

    expect(unity.job_description).toContain(illustrativePatterns)
    expect(unity.job_description).toContain(pipelineWork)
    expect(technical).toHaveLength(26)
    expect(skillsFromPattern.map((skill) => skill.canonical)).toEqual(['Agents', 'ReAct'])
    expect(skillsFromVectorDatabaseList.map((skill) => skill.canonical)).toEqual([
      'MCP',
      'Vector Databases',
      'Observability',
    ])
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw_text: pipelineWork, canonical: 'RAG' }),
      expect.objectContaining({ raw_text: pipelineWork, canonical: 'Evaluation' }),
      expect.objectContaining({ canonical: 'Full-stack development', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Backend development', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Frontend development', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Cloud', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Containerization', requirement: 'required' }),
      expect.objectContaining({ canonical: 'APIs', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Serverless', requirement: 'required' }),
      expect.objectContaining({ raw_text: 'Elasticsearch', canonical: 'Elasticsearch' }),
      expect.objectContaining({ raw_text: 'pgvector', canonical: 'pgvector' }),
    ]))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Tool calling' }),
      expect.objectContaining({ canonical: 'Chain-of-Thought' }),
      expect.objectContaining({ canonical: 'Fine-tuning' }),
      expect.objectContaining({ canonical: 'LangGraph' }),
      expect.objectContaining({ canonical: 'AutoGen' }),
      expect.objectContaining({ canonical: 'CrewAI' }),
    ]))
  })

  it('keeps Golden 007 workflow automation distinct from Agents', () => {
    const coreWorkflow = 'Workflow automation and orchestration — agents, triggers, conditional logic'
    const providerExamples = 'LLM APIs (OpenAI, Anthropic, etc.)'
    const technical = waveSix.expected_extraction.technical_skills
      .filter((skill) => skill.raw_text === coreWorkflow)

    expect(waveSix.job_description).toContain(`• ${coreWorkflow}`)
    expect(waveSix.job_description).toContain(providerExamples)
    expect(waveSix.expected_extraction.technical_skills).toHaveLength(30)
    expect(technical.map((skill) => skill.canonical)).toEqual([
      'workflow automation',
      'Agents',
    ])
    expect(waveSix.expected_extraction.technical_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'LLMs', requirement: 'required' }),
      expect.objectContaining({
        raw_text: providerExamples,
        canonical: 'APIs',
        requirement: 'required',
        alternative_group: null,
      }),
      expect.objectContaining({ canonical: 'OpenAI', requirement: 'required', alternative_group: null }),
      expect.objectContaining({ canonical: 'Anthropic', requirement: 'required', alternative_group: null }),
      expect.objectContaining({ canonical: 'Data pipelines', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'Data modeling', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'Cloud', requirement: 'nice_to_have' }),
    ]))
  })

  it('keeps Golden 008 explicit capabilities without promoting maturity descriptors', () => {
    const technical = ellamind.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Python',
      'LLMs',
      'APIs',
      'OpenAI',
      'Anthropic',
      'Software engineering',
      'API Design',
      'Data modeling',
      'Async Processing',
      'Distributed Systems',
      'Evaluation',
    ])
    expect(technical.find((skill) => skill.canonical === 'APIs'))
      .toEqual(expect.objectContaining({
        raw_text: expect.stringContaining('Practical work with OpenAI, Anthropic, or similar APIs'),
        requirement: 'required',
      }))
    expect(technical.find((skill) => skill.canonical === 'Software engineering'))
      .toEqual(expect.objectContaining({
        raw_text: expect.stringContaining('Software engineering fundamentals'),
        requirement: 'required',
      }))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Testing' }),
      expect.objectContaining({ canonical: 'Performance Optimization' }),
      expect.objectContaining({ canonical: 'Error Handling' }),
    ]))
  })

  it('reopens earlier cloud and provider examples without collapsing their parent skills', () => {
    expect(artefact.expected_extraction.technical_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Cloud', requirement: 'required' }),
      expect.objectContaining({ canonical: 'GCP', alternative_group: 'cloud_platform' }),
    ]))
    expect(mercanis.expected_extraction.technical_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Cloud', requirement: 'required' }),
      expect.objectContaining({ canonical: 'OpenAI', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Anthropic', requirement: 'required' }),
      expect.objectContaining({ canonical: 'AWS Bedrock', requirement: 'required' }),
    ]))
    expect(smartbroker.expected_extraction.technical_skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Cloud', requirement: 'required' }),
      expect.objectContaining({ canonical: 'GCP', alternative_group: 'cloud_platform' }),
    ]))
  })

  it('keeps Golden 009 concrete examples while grouping interchangeable frameworks', () => {
    const technical = reedsy.expected_extraction.technical_skills
    const independentlyScored = ['LLM orchestration', 'AI developer tooling', 'Cursor']
    expect(technical).toHaveLength(19)
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'AI/ML', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Evaluation', requirement: 'required' }),
      expect.objectContaining({ canonical: 'LLMs', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Prompt engineering', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Fine-tuning', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Model Selection', requirement: 'required' }),
      expect.objectContaining({ canonical: 'RAG', requirement: 'required' }),
      expect.objectContaining({ canonical: 'LLM orchestration', requirement: 'required' }),
      expect.objectContaining({ canonical: 'LangChain', requirement: 'required' }),
      expect.objectContaining({ canonical: 'LlamaIndex', requirement: 'required' }),
      expect.objectContaining({ canonical: 'AI developer tooling', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Cursor', requirement: 'required' }),
    ]))
    expect(technical.filter((skill) => skill.alternative_group === 'ai_framework')
      .map((skill) => skill.canonical)).toEqual(['LangChain', 'LlamaIndex'])
    for (const canonical of independentlyScored) {
      expect(technical).toEqual(expect.arrayContaining([
        expect.objectContaining({ canonical, alternative_group: null }),
      ]))
    }
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'custom chaining frameworks' }),
      expect.objectContaining({ canonical: 'intelligent CI/CD' }),
      expect.objectContaining({ canonical: 'AI-powered QA' }),
    ]))
  })

  it('keeps Golden 011 dedicated stack skills and candidate-facing nice-to-haves', () => {
    const technical = techstaff.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Python',
      'FastAPI',
      'SQL',
      'NoSQL',
      'LLMs',
      'APIs',
      'Embeddings',
      'AWS',
      'Azure',
      'GCP',
      'Docker',
      'Kubernetes',
      'Airflow',
      'Apache Spark',
      'PySpark',
      'Git',
      'CI/CD',
      'Recommender Systems',
      'Data Platforms',
      'ML Engineering',
    ])
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw_text: 'LLM APIs', canonical: 'APIs', requirement: 'required', alternative_group: null }),
      expect.objectContaining({ raw_text: 'production ML', canonical: 'ML Engineering', requirement: 'nice_to_have', alternative_group: null }),
      expect.objectContaining({ canonical: 'SQL', alternative_group: 'database_technology' }),
      expect.objectContaining({ canonical: 'NoSQL', alternative_group: 'database_technology' }),
      expect.objectContaining({ canonical: 'AWS', alternative_group: 'cloud_platform' }),
      expect.objectContaining({ canonical: 'Azure', alternative_group: 'cloud_platform' }),
      expect.objectContaining({ canonical: 'GCP', alternative_group: 'cloud_platform' }),
      expect.objectContaining({ canonical: 'Apache Spark', alternative_group: 'spark_runtime' }),
      expect.objectContaining({ canonical: 'PySpark', alternative_group: 'spark_runtime' }),
    ]))
  })

  it('keeps Golden 012 engineering evidence under one broad criterion', () => {
    const technical = sparetech.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Software engineering',
      'LLMs',
      'RAG',
      'Prompt engineering',
      'Evaluation',
      'security guardrails',
      'workflow automation',
    ])
    expect(technical.find((skill) => skill.canonical === 'Software engineering')).toEqual(expect.objectContaining({
      raw_text: expect.stringContaining('engineering foundation'),
      requirement: 'required',
      alternative_group: null,
    }))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'automation/integrations' }),
      expect.objectContaining({ canonical: 'Testing' }),
    ]))
  })

  it('keeps Golden 013 independent skills while grouping genuine substitutes', () => {
    const technical = dexterHealth.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Software engineering',
      'Python',
      'AI application development',
      'LLMs',
      'Evaluation',
      'Testing',
      'AI Integration',
      'Claude Code',
      'Codex',
      'Cursor',
      'GitHub Copilot',
      'Frontend development',
      'Full-stack development',
      'Self-hosted LLMs',
      'Model serving',
      'Inference optimization',
      'Open-source LLMs',
      'AI deployment',
      'AI systems optimization',
      'Structured data extraction',
      'workflow automation',
    ])
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(11)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(10)

    const choices = Object.values(Object.groupBy(
      technical.filter((skill) => skill.alternative_group !== null),
      (skill) => skill.alternative_group,
    )).map((group) => group.map((skill) => skill.canonical))
    expect(choices).toEqual([
      ['AI application development', 'LLMs'],
      ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot'],
      ['Frontend development', 'Full-stack development'],
    ])
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'AI development tools' }),
      expect.objectContaining({ canonical: 'AI developer tooling' }),
      expect.objectContaining({ canonical: 'Backend development' }),
      expect.objectContaining({ canonical: 'documentation automation' }),
      expect.objectContaining({ canonical: 'voice workflows' }),
    ]))
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw_text: 'Copilot', canonical: 'GitHub Copilot', alternative_group: 'ai_development_tool' }),
    ]))
  })

  it('keeps Golden 014 candidate skills and groups interchangeable AI frameworks', () => {
    const technical = iu.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Software engineering',
      'Backend development',
      'Python',
      'FastAPI',
      'LangChain',
      'LlamaIndex',
      'API Design',
      'Testing',
      'LLMs',
      'Agents',
      'Prompt engineering',
      'RAG',
      'Tool calling',
    ])
    expect(technical).toHaveLength(13)
    expect(technical.every((skill) => skill.requirement === 'required')).toBe(true)
    expect(technical.filter((skill) => skill.alternative_group === 'ai_framework')
      .map((skill) => skill.canonical)).toEqual(['LangChain', 'LlamaIndex'])
    expect(technical.filter((skill) => skill.alternative_group !== null)).toHaveLength(2)
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'APIs' }),
      expect.objectContaining({ canonical: 'LLM orchestration' }),
      expect.objectContaining({ canonical: 'AI ecosystem' }),
      expect.objectContaining({ canonical: 'Performance Optimization' }),
    ]))
  })

  it('keeps Golden 015 AI integration, agentic systems, and coding tooling distinct', () => {
    const technical = lufinity.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Software engineering',
      'Python',
      'LLMs',
      'AI Integration',
      'AI/ML',
      'RAG',
      'Agents',
      'AI developer tooling',
      'C#',
      'React',
    ])
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(8)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(2)
    expect(technical.every((skill) => skill.alternative_group === null)).toBe(true)
    expect(technical.find((skill) => skill.canonical === 'Agents')).toEqual(expect.objectContaining({
      raw_text: 'agentic systems',
      requirement: 'required',
    }))
    expect(technical.find((skill) => skill.canonical === 'AI developer tooling')).toEqual(expect.objectContaining({
      raw_text: 'Practical experience with coding agents',
      requirement: 'required',
    }))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'AI/ML ecosystem' }),
      expect.objectContaining({ canonical: 'LLM Integration' }),
      expect.objectContaining({ canonical: 'Coding Agents' }),
    ]))
  })

  it('keeps Golden 016 platform parents, concrete stack skills, and alternatives distinct', () => {
    const technical = netconomy.expected_extraction.technical_skills

    expect(technical).toHaveLength(27)
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(15)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(12)
    expect(technical.filter((skill) => skill.alternative_group === 'applied_ai_or_ml')
      .map((skill) => skill.canonical)).toEqual(['AI/ML', 'Machine Learning'])
    expect(technical.filter((skill) => skill.alternative_group === 'agent_framework')
      .map((skill) => skill.canonical)).toEqual(['LangGraph', 'Google ADK', 'Agno'])
    expect(technical.filter((skill) => skill.alternative_group === 'cloud_platform')
      .map((skill) => skill.canonical)).toEqual(['GCP', 'AWS', 'Azure'])
    expect(technical.filter((skill) => skill.alternative_group === 'ai_evaluation_framework')
      .map((skill) => skill.canonical)).toEqual(['Ragas', 'LangSmith'])
    const groupSizes = technical.filter((skill) => skill.alternative_group !== null)
      .reduce((sizes, skill) => ({
        ...sizes,
        [skill.alternative_group]: (sizes[skill.alternative_group] ?? 0) + 1,
      }), {})
    expect(technical.length - Object.values(groupSizes)
      .reduce((duplicates, size) => duplicates + size - 1, 0)).toBe(21)
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Cloud', requirement: 'required', alternative_group: null }),
      expect.objectContaining({ canonical: 'Vertex AI', requirement: 'nice_to_have', alternative_group: null }),
      expect.objectContaining({ canonical: 'Gemini', requirement: 'nice_to_have', alternative_group: null }),
      expect.objectContaining({ canonical: 'Vector Search', requirement: 'nice_to_have', alternative_group: null }),
      expect.objectContaining({ canonical: 'AIOps', requirement: 'nice_to_have', alternative_group: null }),
    ]))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Grounding' }),
      expect.objectContaining({ canonical: 'RAG' }),
      expect.objectContaining({ canonical: 'Google Cloud AI/ML' }),
    ]))
  })

  it('keeps Golden 017 ML lifecycle stages and deep-learning choices distinct', () => {
    const technical = micro1.expected_extraction.technical_skills

    expect(technical.map((skill) => skill.canonical)).toEqual([
      'Machine Learning',
      'Model Development',
      'AI deployment',
      'Python',
      'Java',
      'CI/CD',
      'AWS',
      'Containerization',
      'Kubernetes',
      'Deep Learning',
      'TensorFlow',
      'PyTorch',
    ])
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(9)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(3)
    expect(technical.filter((skill) => skill.alternative_group === 'programming_language')
      .map((skill) => skill.canonical)).toEqual(['Python', 'Java'])
    expect(technical.filter((skill) => skill.alternative_group === 'deep_learning_framework')
      .map((skill) => skill.canonical)).toEqual(['TensorFlow', 'PyTorch'])
    const independentCriteria = technical.filter((skill) => skill.alternative_group === null).length
    const alternativeCriteria = new Set(technical.map((skill) => skill.alternative_group).filter(Boolean)).size
    expect(independentCriteria + alternativeCriteria).toBe(10)
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Software engineering' }),
      expect.objectContaining({ canonical: 'Data pipelines' }),
      expect.objectContaining({ canonical: 'Open-Source AI' }),
    ]))
  })

  it('keeps Golden 018 nested technical specificity and genuine alternatives', () => {
    const technical = quantori.expected_extraction.technical_skills

    expect(technical).toHaveLength(38)
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(33)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(5)
    expect(technical.filter((skill) => skill.alternative_group === 'api_framework')
      .map((skill) => skill.canonical)).toEqual(['FastAPI', 'Flask'])
    expect(technical.filter((skill) => skill.alternative_group === 'data_store_type')
      .map((skill) => skill.canonical)).toEqual(['SQL', 'Object Storage', 'NoSQL'])
    expect(technical.filter((skill) => skill.alternative_group === 'sql_database')
      .map((skill) => skill.canonical)).toEqual(['PostgreSQL', 'MySQL'])

    const independentCriteria = technical.filter((skill) => skill.alternative_group === null).length
    const alternativeCriteria = new Set(technical.map((skill) => skill.alternative_group).filter(Boolean)).size
    expect(independentCriteria + alternativeCriteria).toBe(34)
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Multi-step reasoning', alternative_group: null }),
      expect.objectContaining({ canonical: 'MLOps', alternative_group: null }),
      expect.objectContaining({ canonical: 'LLMOps', alternative_group: null }),
      expect.objectContaining({ canonical: 'Cheminformatics', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'RDKit', requirement: 'nice_to_have' }),
    ]))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Prompt engineering' }),
      expect.objectContaining({ canonical: 'workflow automation' }),
      expect.objectContaining({ canonical: 'Healthcare/Life Sciences' }),
    ]))

    const exact = {
      skills: technical.map((skill) => ({ ...skill })),
      non_skill_mentions: quantori.expected_extraction.non_skill_mentions.map((mention) => ({ ...mention })),
    }
    expect(scoreExtraction(exact, quantori.expected_extraction).technical).toEqual({
      expected: 38,
      actual: 38,
      canonical_precision: 1,
      canonical_recall: 1,
      requirement_accuracy: 1,
      alternative_group_accuracy: 1,
      expected_alternative_groups: 3,
      actual_alternative_groups: 3,
    })
  })

  it('keeps Golden 019 broad capabilities, stable examples, and one genuine alternative', () => {
    const technical = tryHackMe.expected_extraction.technical_skills

    expect(technical).toHaveLength(19)
    expect(technical.filter((skill) => skill.requirement === 'required')).toHaveLength(5)
    expect(technical.filter((skill) => skill.requirement === 'nice_to_have')).toHaveLength(14)
    expect(technical.filter((skill) => skill.alternative_group === 'cyber_security_space')
      .map((skill) => skill.canonical)).toEqual([
        'Cyber ranges',
        'Red team tooling',
        'Security simulation',
      ])

    const independentCriteria = technical.filter((skill) => skill.alternative_group === null).length
    const alternativeCriteria = new Set(technical.map((skill) => skill.alternative_group).filter(Boolean)).size
    expect(independentCriteria + alternativeCriteria).toBe(17)
    expect(technical).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'LLMs', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Agents', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Agent architecture', requirement: 'required' }),
      expect.objectContaining({ canonical: 'Cybersecurity', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'MITRE ATT&CK', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'Adversary emulation', requirement: 'nice_to_have' }),
      expect.objectContaining({ canonical: 'Multi-Agent Systems', requirement: 'nice_to_have' }),
    ]))
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Tool calling' }),
      expect.objectContaining({ canonical: 'Chain-of-Thought' }),
      expect.objectContaining({ canonical: 'State Management' }),
    ]))
  })

  it('keeps Golden 020 candidate libraries and orchestration but excludes workflow and responsibility noise', () => {
    const technical = zdfSparks.expected_extraction.technical_skills

    expect(technical).toHaveLength(12)
    expect(technical.every((skill) => skill.requirement === 'required')).toBe(true)
    expect(technical.every((skill) => skill.alternative_group === null)).toBe(true)
    expect(technical.map((skill) => skill.canonical)).toEqual([
      'LLMs',
      'Python',
      'pandas',
      'NumPy',
      'SQL',
      'Data Visualization',
      'Jupyter Notebooks',
      'scikit-learn',
      'LangChain',
      'LLM orchestration',
      'Vector Databases',
      'CI/CD',
    ])
    expect(technical).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Code review' }),
      expect.objectContaining({ canonical: 'Streamlit' }),
      expect.objectContaining({ canonical: 'Pull Requests' }),
    ]))

    const exact = {
      skills: technical.map((skill) => ({ ...skill })),
      non_skill_mentions: zdfSparks.expected_extraction.non_skill_mentions.map((mention) => ({ ...mention })),
    }
    expect(scoreExtraction(exact, zdfSparks.expected_extraction).technical).toEqual({
      expected: 12,
      actual: 12,
      canonical_precision: 1,
      canonical_recall: 1,
      requirement_accuracy: 1,
      alternative_group_accuracy: 1,
      expected_alternative_groups: 0,
      actual_alternative_groups: 0,
    })
  })

  it('gives the real golden reference a perfect deterministic score', () => {
    const score = scoreExtraction(exactResult(), expected)

    expect(score.technical).toEqual({
      expected: 12,
      actual: 12,
      canonical_precision: 1,
      canonical_recall: 1,
      requirement_accuracy: 1,
      alternative_group_accuracy: 1,
      expected_alternative_groups: 2,
      actual_alternative_groups: 2,
    })
    expect(score.audit).toEqual({
      expected: 13,
      actual: 13,
      non_skill_precision: 1,
      non_skill_recall: 1,
      category_label_accuracy: 1,
      structured_accuracy: 1,
      by_category: {
        qualification: { expected: 0, predicted: 0, matched: 0, precision: null, recall: null },
        experience_requirement: { expected: 3, predicted: 3, matched: 3, precision: 1, recall: 1 },
        soft_skill: { expected: 2, predicted: 2, matched: 2, precision: 1, recall: 1 },
        eligibility: { expected: 0, predicted: 0, matched: 0, precision: null, recall: null },
        language_requirement: { expected: 0, predicted: 0, matched: 0, precision: null, recall: null },
        responsibility: { expected: 7, predicted: 7, matched: 7, precision: 1, recall: 1 },
      },
    })
  })

  it('requires both Golden 017 alternative sets to stay grouped, independent of group labels', () => {
    const result = exactResult()
    result.skills = result.skills.map((skill) => (
      skill.alternative_group === 'programming_language'
        ? { ...skill, alternative_group: 'any-language' }
        : skill.alternative_group === 'deep_learning_framework'
          ? { ...skill, alternative_group: 'any-deep-learning-framework' }
        : skill
    ))
    expect(scoreExtraction(result, expected).technical.alternative_group_accuracy).toBe(1)

    result.skills = result.skills.map((skill) => ({ ...skill, alternative_group: null }))
    const score = scoreExtraction(result, expected)
    expect(score.technical.canonical_precision).toBe(1)
    expect(score.technical.canonical_recall).toBe(1)
    expect(score.technical.alternative_group_accuracy).toBe(0)
  })

  it('flags a wrong audit category even when its source text is preserved', () => {
    const result = exactResult()
    result.non_skill_mentions = result.non_skill_mentions.map((mention) => (
      mention.category === 'credential' ? { ...mention, category: 'soft_skill' } : mention
    ))

    expect(scoreExtraction(result, expected).audit).toMatchObject({
      non_skill_recall: 1,
      category_label_accuracy: 12 / 13,
      structured_accuracy: 12 / 13,
    })
  })

  it('penalizes technical and audit false positives without reducing recall', () => {
    const result = exactResult()
    result.skills.push({ raw_text: 'Invented platform', canonical: 'Invented platform', requirement: 'required', alternative_group: null })
    result.non_skill_mentions.push({ raw_text: 'Invented requirement', category: 'soft_skill', requirement: 'required' })
    const expectedSkillCount = expected.technical_skills.length
    const expectedAuditCount = expected.non_skill_mentions.length

    expect(scoreExtraction(result, expected).technical).toMatchObject({
      canonical_precision: expectedSkillCount / (expectedSkillCount + 1),
      canonical_recall: 1,
    })
    expect(scoreExtraction(result, expected).audit).toMatchObject({
      non_skill_precision: expectedAuditCount / (expectedAuditCount + 1),
      non_skill_recall: 1,
    })
  })

  it('keeps category precision and recall separate when a soft-skill false positive hides in the aggregate', () => {
    const result = exactResult()
    result.non_skill_mentions = result.non_skill_mentions.map((mention) => (
      mention.category === 'credential' ? { ...mention, category: 'soft_skill' } : mention
    ))

    const score = scoreExtraction(result, expected)
    expect(score.audit).toMatchObject({
      non_skill_precision: 1,
      non_skill_recall: 1,
      category_label_accuracy: 12 / 13,
    })
    expect(score.audit.by_category.soft_skill).toEqual({
      expected: 2,
      predicted: 3,
      matched: 2,
      precision: 2 / 3,
      recall: 1,
    })
    expect(score.audit.by_category.experience_requirement).toEqual({
      expected: 3,
      predicted: 3,
      matched: 3,
      precision: 1,
      recall: 1,
    })
  })
})
