# job-pipeline

**See What AI Employers Want** — answers one question, visually: *what skills are the job market prioritizing?*

Job hunting in AI engineering is confusing. Outside Python and LLM basics, every company wants something different — MLOps, RAG, agents, LangChain, cloud, eval. Drop in screenshots of job descriptions you're applying to, and get a live view of what the market's actually prioritizing — by skill, by seniority, per job vs. your own resume.

> Built solo at a one-day AI hackathon. Open source (MIT).
> **Live:** https://job-pipeline-opal.vercel.app

## The idea
Job descriptions are inconsistent and unstructured — "React", "ReactJS", and "React.js" are the
same skill written three ways, and the signal (what employers actually want) is buried. This tool
reads 20+ real AI-Engineer JD screenshots with a vision model, reconciles the skill names, and
aggregates by **document frequency** (how many jobs mention a skill) to surface the real market signal.

## What it does
- **Ranked skills chart** — skills by how many jobs ask for them (the headline).
- **Stats bar** — N jobs · N unique skills · N companies.
- **Seniority "compare by level"** — re-scope the chart to Junior / Mid / Senior and watch the priorities shift (Junior → fundamentals; Senior → cloud/infra climbs into the top).
- **Job list** — company, title, inferred seniority (with the evidence on hover), summary.
- **Click-to-filter** — click a skill → the jobs that want it; click a job → its full skill set.
- **"Merged from" reveal** — hover a skill to see the raw variants that normalized into it (the extraction at work).
- **Live drop-in** — upload a new screenshot and watch it parse on the spot, extraction running in a **Daytona** sandbox, then fold into the chart.

## How it works
```
JD screenshots ──(Python + vision model, structured JSON)──▶ normalize ──▶ jobs.json
                                                                              │
                                                React dashboard reads /jobs.json
                                                                              │
                                                       deployed on Vercel (one URL)
```

**The pipeline, step by step:**
1. **Extract (per screenshot).** A Python script loops the ~20 screenshots; for each it calls a vision model and gets back structured data — company, title, seniority (+ the evidence), summary, and a list of skills, each as `raw_text` (as written) + an `extracted_skill` concept label + required/nice-to-have. The model does not assign the final canonical identity.
2. **Pool** the raw skills from every job into one list.
3. **Normalize — deterministically, once.** Plain Python over the whole pool: split slash-lists ("GCP/AWS/Azure" → 3 skills) → case-fold ("Vector Databases" = "vector databases") → apply a hand-written canonical alias map ("large language models" → "LLMs"). Same input, same output, every run.
4. **Aggregate.** Count how many jobs mention each canonical skill (document frequency) and build the skill↔job indexes.
5. **Write `jobs.json`** to `dashboard/public/`.
6. **Render.** The React app reads `/jobs.json` and draws the dashboard.

**Where's the AI vs. the plain code?** The AI reads the messy images; deterministic Python makes the results consistent and counts them. The model is the "smart but inconsistent" step; the code is the "consistent bookkeeping" step. Why the split: each screenshot is extracted on its own, so the model can't be consistent across the set (and isn't even repeatable run to run) — see `DECISIONS.md`.

**Notes:**
- No live backend for the *core* dashboard — extraction runs offline and writes a static `jobs.json`.
- The **live drop-in** adds one Vercel serverless function that runs the extraction in a **Daytona** sandbox — same repo, no separate host.
- Frontend: Vite + React; the chart is hand-rolled CSS bars (no chart library).

## Tech stack
- **Extraction:** Python, `anthropic` / `openai` SDK (provider-agnostic; ran on Claude Sonnet), Pydantic, uv
- **Frontend:** Vite + React (CSS-bar chart, no chart lib)
- **Sandbox runtime:** Daytona (`@daytona/sdk`) — runs the live drop-in's extraction
- **Deploy:** Vercel (push-to-deploy; serverless function for the drop-in)

## Repo layout
```
job-pipeline/
  extract.py              # Phase 1: vision extraction over the screenshots → data/extracted.json
  normalize.py            # Phase 2: deterministic normalization → dashboard/public/jobs.json
  test_key.py             # one-call API-key smoke test (both providers)
  data/extracted.json     # raw per-job extraction (pre-normalization)
  scratch/                # de-risk notebook + Daytona hello-world (prep)
  dashboard/              # the React app (Vite)
    src/App.jsx           # the dashboard (chart, stats, job list, filters, upload, résumé match)
    api/extract.js        # Vercel serverless fn → Daytona sandbox (live JD drop-in)
    api/resume.js         # Vercel serverless fn → Daytona sandbox (résumé match)
    api/canonicalMap.js   # normalization map for live jobs (generated by normalize.py)
    public/jobs.json      # the normalized dataset the app reads (generated)
  jd-aggregator-sprint-plan.md     # scope, architecture, the live features + how they work
  DECISIONS.md                     # why the calls were made (plain English)
```

## Status
**Feature-complete and live.** The dashboard (ranked chart, stats, job list, click-to-filter,
seniority compare-by-level, and the "merged from" reveal) and the **live Daytona drop-in** are all
built and deployed on one Vercel URL. Extraction runs over a corpus of 20 real AI-Engineer JD
screenshots; normalization is deterministic Python. Built solo in a one-day hackathon — the planning
docs in this repo (`jd-aggregator-sprint-plan.md`, `DECISIONS.md`, etc.) trace how it came together.

## Vision (two parts)
1. **JD aggregator** (this) — what the market wants.
2. **Email parser** (later) — parses your application emails to track where you've applied.

Both share one `job` data model, so they join into a single picture: what the market wants, and
where *you* stand in it.

## License
MIT — see [LICENSE](LICENSE).
