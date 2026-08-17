"""Phase 2 — Normalization (deterministic, runs once over the whole pool).

Reads data/extracted.json (raw per-job extraction), cleans the skill names with
plain code, aggregates, and writes dashboard/public/jobs.json for the React app.

The three steps, in order (see the plan's "Where normalization must live"):
  1. split known slash-lists ("GCP/AWS/Azure" -> 3 skills); CI/CD etc. are protected
  2. case-fold (group by lowercase; display = the most common spelling seen)
  3. apply a small, conservative hand-written alias map for real synonyms

Run:  uv run normalize.py
"""

import collections
import json
from pathlib import Path

IN_PATH = Path("data/extracted.json")
OUT_PATH = Path("dashboard/public/jobs.json")

# 1. Known multi-skill slash-lists to split. Only these split; everything else
#    (CI/CD, A/B Testing, ETL/ELT, ...) is left intact.
SPLITS = {
    "gcp/aws/azure": ["GCP", "AWS", "Azure"],
    "n8n/make/zapier": ["n8n", "Make", "Zapier"],
    "bigquery/snowflake": ["BigQuery", "Snowflake"],
}

# 3. Conservative alias map: lowercased spelling -> canonical display name.
#    Only merges we've eyeballed in the real data. When unsure, leave separate.
ALIASES = {
    "llm apis": "LLMs",
    "llm orchestration": "LLMs",
    "generative ai": "LLMs",            # gen AI in these JDs = LLM-based (domain call)
    "generative ai applications": "LLMs",
    "generative ai solutions": "LLMs",
    "large language models": "LLMs",
    "google cloud platform": "GCP",
    "model fine-tuning": "Fine-tuning",
    "retrieval-augmented generation": "RAG",
    "agentic frameworks": "Agents",
    "agent frameworks": "Agents",
    "agentic ai frameworks": "Agents",
    "apache airflow": "Airflow",
    "version control": "Git",
    "github": "Git",
    # Evaluation — the model scattered it across many canonicals; consolidate.
    "ai evaluation": "Evaluation",
    "ai evaluation & benchmarking": "Evaluation",
    "ai evaluation & observability": "Evaluation",
    "ai output evaluation": "Evaluation",
    "model evaluation": "Evaluation",
    "evaluation frameworks": "Evaluation",
    "llm evaluation": "Evaluation",
    # Monitoring / observability — same scattering.
    "ai observability": "Observability",
    "ai observability & monitoring": "Observability",
    "model monitoring": "Observability",
    "monitoring": "Observability",
    "monitoring & observability": "Observability",
    # Fine-tuning (clearly the same skill)
    "llm fine-tuning": "Fine-tuning",
    # APIs (generic) — keep FastAPI and LLM APIs separate
    "api design": "APIs",
    "api development": "APIs",
    "api integration": "APIs",
    "api integrations": "APIs",
    "apis": "APIs",
    "rest apis": "APIs",
    "restful apis": "APIs",
    # Testing (QA) — keep A/B Testing separate
    "test automation": "Testing",
    "automated testing": "Testing",
    "integration testing": "Testing",
    "debugging & testing": "Testing",
    # Cloud (generic) — GCP / AWS / Azure stay separate
    "cloud infrastructure": "Cloud",
    "cloud platforms": "Cloud",
    # Data pipelines (generic) — keep Airflow / Prefect / dbt as their own bars
    "etl pipelines": "Data pipelines",
    "data pipelines": "Data pipelines",
}


def split_skill(canonical: str) -> list[str]:
    key = canonical.strip().lower()
    if key in SPLITS:
        return SPLITS[key]
    return [canonical.strip()]


# --- Pure normalization logic (no I/O — tested directly) --------------------------

def build_display(jobs: list[dict]) -> dict[str, str]:
    """Pick a display spelling per case-folded key = the most common one seen."""
    spelling_counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for job in jobs:
        for s in job["skills"]:
            for part in split_skill(s["canonical"]):
                spelling_counts[part.lower()][part] += 1
    return {key: c.most_common(1)[0][0] for key, c in spelling_counts.items()}


def resolve(part: str, display: dict[str, str]) -> str:
    """A raw skill part -> its final canonical: alias first, else the display spelling."""
    key = part.strip().lower()
    if key in ALIASES:
        return ALIASES[key]
    return display.get(key, part.strip())


def clean_variants(canon: str, raws) -> list[str]:
    """The "merged from" reveal: keep short, skill-like phrasings that folded into
    `canon` — dedupe case-insensitively, drop the canonical itself, cap for display."""
    seen = {}
    # (len, value) tiebreak, not len alone: equal-length variants must break
    # deterministically, else set-iteration order (hash-randomized) picks the survivor
    # and jobs.json varies run to run. See DECISIONS.md.
    for r in sorted(raws, key=lambda r: (len(r), r)):
        r = r.strip()
        low = r.lower()
        if not r or len(r) > 40 or low == canon.lower() or low in seen:
            continue
        seen[low] = r
    return sorted(seen.values())[:6]


def normalize_jobs(jobs: list[dict], display: dict[str, str]) -> tuple[list[dict], dict[str, list]]:
    """Rebuild each job's skills with normalized canonicals and preserve the extraction
    audit. Ordinary canonicals dedupe with required winning; explicit alternative groups
    stay separate requirements. Collect the per-canonical "merged from" variants map."""
    variants: dict[str, set] = collections.defaultdict(set)
    out_jobs = []
    for job in jobs:
        by_identity: dict[tuple[str, str | None], dict] = {}
        for s in job["skills"]:
            for part in split_skill(s["canonical"]):
                canon = resolve(part, display)
                variants[canon].add(s["raw_text"].strip())
                alternative_group = s.get("alternative_group") or None
                identity = (canon, alternative_group)
                if identity not in by_identity:
                    by_identity[identity] = {
                        "canonical": canon,
                        "raw_text": s["raw_text"],
                        "requirement": s["requirement"],
                        "alternative_group": alternative_group,
                    }
                elif s["requirement"] == "required":
                    by_identity[identity]["requirement"] = "required"  # prefer required if any mention is
        out_jobs.append({
            "id": job["id"],
            "company": job["company"],
            "title": job["title"],
            "seniority": job["seniority"],
            "seniority_signal": job["seniority_signal"],
            "seniority_basis": job["seniority_basis"],
            "summary": job["summary"],
            "source": job.get("source", "screenshot"),
            "non_skill_mentions": job.get("non_skill_mentions", []),
            "skills": list(by_identity.values()),
        })

    skill_variants = {}
    for canon, raws in variants.items():
        cv = clean_variants(canon, raws)
        if cv:
            skill_variants[canon] = cv
    return out_jobs, skill_variants


def build_canon_map(display: dict[str, str]) -> dict:
    """The static map the live drop-in (Daytona) uses to normalize a single new job the
    same way: lowercased spelling -> final display canonical, plus the slash-splits."""
    canon_map = {k: ALIASES.get(k, v) for k, v in display.items()}
    canon_map.update(ALIASES)
    return {"splits": SPLITS, "map": canon_map}


# --- I/O wrapper ------------------------------------------------------------------

def main():
    data = json.loads(IN_PATH.read_text())
    jobs = data["jobs"]

    display = build_display(jobs)
    out_jobs, skill_variants = normalize_jobs(jobs, display)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(
        {"generated_at": data.get("generated_at"), "jobs": out_jobs, "skill_variants": skill_variants},
        indent=2, ensure_ascii=False,
    ))

    # Written as a JS module so the serverless function can import it directly.
    payload = build_canon_map(display)
    Path("dashboard/public/canonical_map.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False)
    )
    Path("dashboard/api/canonicalMap.js").write_text(
        "// generated by normalize.py — do not edit by hand\nexport default "
        + json.dumps(payload, indent=2, ensure_ascii=False)
        + "\n"
    )

    # --- eyeball: the ranked chart (document frequency), default view (required + >=2) ---
    df_required = collections.Counter()
    df_all = collections.Counter()
    companies = set()
    canon_all = set()
    for job in out_jobs:
        if job["company"]:
            companies.add(job["company"].strip().lower())
        req_seen, all_seen = set(), set()
        for s in job["skills"]:
            canon_all.add(s["canonical"])
            if s["canonical"] not in all_seen:
                df_all[s["canonical"]] += 1
                all_seen.add(s["canonical"])
            if s["requirement"] == "required" and s["canonical"] not in req_seen:
                df_required[s["canonical"]] += 1
                req_seen.add(s["canonical"])

    print(f"Wrote {OUT_PATH}")
    print(f"Stats: {len(out_jobs)} jobs · {len(canon_all)} skills · {len(companies)} companies\n")
    print("Default chart (required-only, document-freq >= 2):")
    for skill, cnt in df_required.most_common():
        if cnt >= 2:
            print(f"  {cnt:2}  {skill}")


if __name__ == "__main__":
    main()
