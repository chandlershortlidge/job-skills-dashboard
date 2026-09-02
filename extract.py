"""Phase 1 — Extraction.

Reads every screenshot in scratch/screenshots/, calls a vision model in
structured-output mode, and writes the raw per-job results to data/extracted.json.
NO normalization here — that's Phase 2 (normalize.py). The model's `extracted_skill`
is a semantic hint; the deterministic step decides the real canonical name.

Run:  uv run extract.py
"""

import base64
import json
import mimetypes
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

# --- config -------------------------------------------------------------------
PROVIDER = "anthropic"                       # "anthropic" or "openai"
ANTHROPIC_MODEL = "claude-sonnet-4-6"
OPENAI_MODEL = "gpt-5-mini-2025-08-07"
SCREENSHOTS_DIR = Path("scratch/screenshots")
OUT_PATH = Path("data/extracted.json")


# --- schema (per-job extraction target) ---------------------------------------
class Seniority(str, Enum):
    junior = "Junior"
    mid = "Mid"
    senior = "Senior"


class SeniorityBasis(str, Enum):
    stated = "stated"
    inferred = "inferred"


class Requirement(str, Enum):
    required = "required"
    nice_to_have = "nice_to_have"


class NonSkillCategory(str, Enum):
    education = "education"
    experience = "experience"
    credential = "credential"
    soft_skill = "soft_skill"
    responsibility = "responsibility"


class Skill(BaseModel):
    raw_text: str = Field(description="the skill exactly as it appeared")
    extracted_skill: str = Field(
        description="one concise semantic skill label; code decides the final canonical identity"
    )
    requirement: Requirement = Field(
        description="required vs nice_to_have; default to required when the JD is ambiguous"
    )
    alternative_group: Optional[str] = Field(
        default=None,
        description="null unless this is one option in an explicit alternative; sibling options share a local id such as alt-1",
    )


class NonSkillMention(BaseModel):
    raw_text: str = Field(description="the full wording exactly as it appeared")
    category: NonSkillCategory
    requirement: Optional[Requirement] = Field(
        default=None,
        description="required or nice_to_have when the JD labels the item; otherwise null for a responsibility",
    )


class JobExtraction(BaseModel):
    company: Optional[str] = Field(description="hiring company; null if cropped/not visible")
    title: Optional[str] = Field(description="role name; null if not in frame")
    seniority: Optional[Seniority]
    seniority_signal: Optional[str] = Field(description="the phrase/years the label keyed off")
    seniority_basis: Optional[SeniorityBasis]
    summary: Optional[str] = Field(description="1-2 sentences: what this role wants")
    skills: list[Skill]
    non_skill_mentions: list[NonSkillMention]


SYSTEM_PROMPT = """You extract structured data from a SINGLE screenshot of a job posting.
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
- seniority_signal: the exact phrase or years the label keyed off
  (e.g. "(Junior)", "initial experience or a very strong interest", "5+ years").
- seniority_basis: "stated" if the posting names the level explicitly, else "inferred".
- summary: 1-2 sentences, what this role wants.
- skills: only distinct technical skills this role asks for: a language, framework,
  platform, tool, technical practice, or technical field the candidate must know or use.
  Do NOT include degrees/fields of study used as education qualifications, years or
  prior-work experience, credentials/publications, soft skills, responsibilities, or
  alternative experience paths. Keep every such visible item in non_skill_mentions.
- extracted_skill: one concise semantic concept label supported by raw_text. This is an
  extraction hint for deterministic normalization, not the final canonical identity.
- non_skill_mentions: each excluded item as raw_text + category (education, experience,
  credential, soft_skill, responsibility) + requirement (required/nice_to_have when
  the JD labels it; otherwise null for a responsibility). This is an audit trail, not
  a skills list.
- requirement: "required" or "nice_to_have". JDs usually split these into "must have" /
  "nice to have" (or "bonus" / "a plus") sections -- key off that. A requirement for
  interest or initial experience in a technical topic still names a technical skill;
  never turn a non-skill into a skill merely to give it this label.
- alternative_group: null for ordinary independent skills. For a clearly substitutable
  choice such as "Python or Java", emit BOTH skills with the same local opaque id,
  e.g. "alt-1". A comma-list remains independent even if its final item uses "or":
  "LLMs, prompt engineering, or RAG" is three skills. Do not silently keep only the
  first option. For named technologies in a generic category, emit the named items:
  "cloud platforms (GCP, AWS, or Azure)" -> GCP, AWS, Azure, not "Cloud Platforms";
  group them only when the wording makes them substitutable.

EXTRACTED SKILL LABELS -- use these concept labels when applicable; code normalizes identity:
- LLMs            <- large language models, LLM, LLM APIs, LLM orchestration
- RAG             <- retrieval-augmented generation
- Agents          <- LLM agents, agentic workflows, multi-agent, agent components
- Prompt engineering <- prompt design/optimization
- Tool calling    <- tool use, function calling, tool/function calling
- CI/CD           <- CI/CD automation
- Keep GCP / AWS / Azure SEPARATE (market signal). Keep LangChain, LlamaIndex, Python, SQL, Docker as-is.

DISCARD UI chrome -- NOT skills: apply buttons, German UI words (Vollzeit), model-name
corner labels (gpt4), verified checkmarks, bookmark/share icons, nav."""

USER_TEXT = "Extract the job posting from this screenshot."


def load_image_b64(path):
    data = Path(path).read_bytes()
    b64 = base64.standard_b64encode(data).decode("utf-8")
    media = mimetypes.guess_type(str(path))[0] or "image/png"
    return b64, media


def extract_anthropic(b64, media):
    from anthropic import Anthropic

    client = Anthropic()
    tool = {
        "name": "record_job",
        "description": "Record the extracted job fields. Use null for anything not visible.",
        "input_schema": JobExtraction.model_json_schema(),
    }
    msg = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        tools=[tool],
        tool_choice={"type": "tool", "name": "record_job"},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}},
            {"type": "text", "text": USER_TEXT},
        ]}],
    )
    for block in msg.content:
        if block.type == "tool_use":
            return JobExtraction.model_validate(block.input)
    raise RuntimeError("No tool_use block returned")


def _openai_parse(client, **kwargs):
    try:
        return client.chat.completions.parse(**kwargs)
    except AttributeError:
        return client.beta.chat.completions.parse(**kwargs)


def extract_openai(b64, media):
    from openai import OpenAI

    client = OpenAI()
    completion = _openai_parse(
        client,
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": USER_TEXT},
                {"type": "image_url", "image_url": {"url": f"data:{media};base64,{b64}"}},
            ]},
        ],
        response_format=JobExtraction,
    )
    return completion.choices[0].message.parsed


def extract(path):
    b64, media = load_image_b64(path)
    if PROVIDER == "anthropic":
        return extract_anthropic(b64, media)
    if PROVIDER == "openai":
        return extract_openai(b64, media)
    raise ValueError(f"Unknown PROVIDER: {PROVIDER}")


def main():
    exts = {".png", ".jpg", ".jpeg", ".webp"}
    shots = sorted(p for p in SCREENSHOTS_DIR.glob("*") if p.suffix.lower() in exts)
    print(f"Found {len(shots)} screenshots. Provider: {PROVIDER}\n")

    jobs = []
    failures = []
    for i, p in enumerate(shots, 1):
        try:
            job = extract(p)
            record = {"id": f"job-{i}", "source_file": p.name, "source": "screenshot", **job.model_dump()}
            jobs.append(record)
            n_skills = len(job.skills)
            print(f"[{i:2}/{len(shots)}] {p.name[:45]:45} -> {n_skills} skills, "
                  f"{job.company or '—'} / {job.seniority.value if job.seniority else '—'}")
        except Exception as e:
            failures.append((p.name, str(e)))
            print(f"[{i:2}/{len(shots)}] {p.name[:45]:45} -> FAILED: {type(e).__name__}: {e}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(
        {"generated_at": datetime.now(timezone.utc).isoformat(), "jobs": jobs},
        indent=2, ensure_ascii=False,
    ))

    total_skills = sum(len(j["skills"]) for j in jobs)
    print(f"\nDone. {len(jobs)} jobs, {total_skills} raw skills -> {OUT_PATH}")
    if failures:
        print(f"{len(failures)} failures:")
        for name, err in failures:
            print(f"  - {name}: {err}")


if __name__ == "__main__":
    main()
