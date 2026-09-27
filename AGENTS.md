
#AGENTS.md

<!-- TEMPLATE-VERSION: 2026-09-19-v4 -->

This is the operating manual for any AI agent working in this repo. Read it before
starting.

The file has two parts:

- a **shared operating manual**, copied from the user's canonical AGENTS template;
- **project specifics**, filled separately for each repository.

Do not make repo-local edits to the shared operating manual unless the person
explicitly asks. Improvements to shared workflow should be made in the canonical
template first, then synced into projects while preserving the project-specific block.

<!-- BEGIN SHARED -->

## Shared guidance (v4)

1. Read the repository's project instructions and relevant README, DECISIONS, and specifications before changing code.

2. Verify files, symbols, interfaces, and repository facts before relying on them. Do not invent missing facts.

3. Follow recorded decisions and existing repository patterns unless the task explicitly changes them.

4. Make the smallest change that satisfies the task. Avoid unrelated refactors and unnecessary dependencies, abstractions, compatibility layers, or features.

5. Preserve existing behavior outside the requested scope.

6. Add deterministic regression tests for meaningful behavior changes and bug fixes. Test observable behavior, including relevant boundaries and failure paths.

7. Use existing real or sample fixtures where available. Do not alter authoritative fixtures merely to make tests pass.

8. Mock provider calls in tests. Never make live provider calls from tests.

9. Run the relevant test suite and other checks proportionate to the change's risk before claiming completion. Report anything not verified.

10. For load-bearing pure logic where ordinary tests may miss semantically wrong behavior—such as scoring, evaluators, parsers, validation, or privacy/data-release boundaries—use mutation testing only when an established mutation workflow already exists and the expected signal justifies the added cost. Do not introduce new mutation-testing infrastructure as part of an unrelated task.

11. Explain changes and results plainly. Report test, build, runtime, API, error, and stack-trace evidence as observed only when actually run or seen in the current session. Surface failures, contradictions, and uncertainty.

12. Verify the final patch against the task, including scope, unintended changes, and consistency with the reported evidence, before claiming completion.

<!-- END SHARED -->

<!-- BEGIN PROJECT -->

## What this project is

**See What AI Employers Want** — a dashboard that reads AI-engineer job-description
screenshots with a vision model, reconciles the messy skill names, and aggregates them
to show what the AI job market is actually prioritizing — by skill, by seniority, and
against your own résumé. Built solo at a one-day hackathon. Full "why" in README.md;
live at https://job-pipeline-opal.vercel.app.

---

## How this project is built and laid out

### Running and testing

```bash
# Install — Python (uv) + frontend (npm)
uv sync                          # Python deps (pyproject.toml / uv.lock)
cd dashboard && npm install      # frontend + serverless-fn deps

# Extraction pipeline (offline; writes the static corpus)
uv run extract.py                # screenshots → data/extracted.json
uv run normalize.py              # → dashboard/public/jobs.json
uv run seed.py                   # load the corpus into Supabase

# Run the dashboard
cd dashboard && npm run dev       # Vite dev server — UI only (no api/ functions)
cd dashboard && vercel dev        # full stack incl. api/ serverless functions
uv run streamlit run streamlit_app.py  # local, read-only LangSmith experiment dashboard
WANDB_PROJECT=<entity/project> node --env-file=.env evals/runWeaveBaseline.mjs --live --confirm-20  # guarded W&B Weave baseline

# Tests (LLM calls are mocked — never live)
uv run pytest                    # Python: normalize.py pure functions + golden fixture
cd dashboard && npm test         # JS: Vitest suite, including API and eval helpers
```

### Stack

- **Extraction (Python 3.13, `uv`):** `anthropic` / `openai` SDKs (provider-agnostic;
  ran on Claude Sonnet), `pydantic`, `python-dotenv`, `supabase`.
- **Frontend:** Vite + React (JSX); the chart is hand-rolled CSS bars — **no chart library**.
- **Serverless (Vercel Functions, Node):** `@daytona/sdk` (runs the live extraction in a
  Daytona sandbox), `@supabase/supabase-js`.
- **Persistence:** Supabase (Postgres) — `job` / `skill` / `cv` tables. Browser reads via
  the anon/publishable key (RLS = **public read only**); all writes happen server-side with
  the service-role key. Source files live in the **private** Supabase Storage bucket
  `sources` (`screenshots/` + `cvs/` prefixes, no anon policies); the only browser read
  path is `GET /api/file` (signed URLs, screenshots only — see storage-blueprint.md D1).

### Where things live

The repo as it is today (keep this updated when files move):

- `extract.py` — Phase 1: vision extraction over the screenshots → `data/extracted.json`.
  *Not* the live drop-in.
- `normalize.py` — Phase 2: deterministic normalization + aggregation →
  `dashboard/public/jobs.json`.
- `seed.py` — loads the normalized corpus into Supabase (`job` / `skill`).
- `test_key.py` — one-call API-key smoke test for both providers. Despite the name,
  *not* a pytest test.
- `dashboard/` — the Vite + React app; Vercel's Root Directory.
  - `dashboard/src/` — React UI: `App.jsx` (the whole dashboard), `App.css`,
    `supabase.js` (browser client + missing-env guard).
  - `dashboard/api/` — Vercel serverless functions (Node): `extract.js` (JD drop-in:
    dup-check + parse + store screenshot + persist), `resume.js` (résumé PDF parse +
    store PDF), `cv.js` (saved-résumé rename/delete), `job.js` (delete a job),
    `file.js` (signed-URL read path for stored screenshots), `canonicalMap.js` (shared
    normalization map), `sourceStore.js` (the only code touching Supabase Storage),
    plus co-located `*.test.js` (excluded from deploys via `dashboard/.vercelignore`).
  - `dashboard/api-lib/jd/` — reusable JD extraction and evaluation logic. It contains
    the no-write vision boundary and deterministic scoring; it does not handle HTTP,
    Supabase, or Storage.
  - `dashboard/public/` — static assets including `jobs.json` (corpus snapshot / fallback).
- `data/` — `extracted.json` (raw per-screenshot extraction output).
- `evals/` — 20 golden JSONL fixtures plus `runBaseline.mjs`, the safe local baseline
  foundation, and `runLangSmithBaseline.mjs`, the guarded live command. The latter
  requires `--live --confirm-20`, runs the no-write extractor sequentially on existing
  LangSmith attachments, and writes one experiment only. The retained CSV inventory
  links database jobs to their local screenshots. `runWeaveBaseline.mjs` is the separate
  guarded W&B Weave path: it verifies all 20 local screenshots before any external write
  or model call, then writes one evaluation without uploading the image bytes.
- `streamlit_app.py` / `langsmith_dashboard_view.py` / `langsmith_dashboard.py` — local,
  read-only LangSmith evaluation UI, pure presentation transformations, and the guarded
  data/comparison boundary. They do not run experiments or write to LangSmith;
  `tests/fixtures/langsmith_experiment_snapshot.json` retains the sanitized real SDK
  shapes used by the mocked pytest suite.
- Other docs: `ARCHITECTURE.md`, `jd-aggregator-sprint-plan.md`
  (design/spec detail beyond README).
- `scratch/` — deliberately preserved experiments only; gitignored, not shipped code.
  Default throwaway probes live in the ephemeral sandbox instead (fixed convention
  across projects — don't rename it).
- `tests/` — pytest suite; JS tests live next to their modules in `dashboard/` and run
  through Vitest.
- `tests/fixtures/` — the real/sample inputs to make available inside the sandbox and
  use in review (fixed convention across projects — don't rename it).

Three layout rules:

- Imports flow one direction — lower-level files don't import from higher-level ones.
- Functions that mix input/output with logic get split into pure logic plus a thin I/O
  wrapper. The pure part is what gets tested.
- Every module gets a top docstring: what it does, what it explicitly does *not* do, and
  the invariants it holds. The "does not" line is the one that matters — it's the boundary
  that keeps code from landing in the wrong place.

### Deploy behavior

Vercel, project **Root Directory = `dashboard`**. Pushing to `main` auto-deploys to
production, so a commit-and-push checkpoint on `main` is also a deploy. Preview deploys
share the production Supabase DB (see pitfalls). Remote: `origin` at
`https://github.com/chandlershortlidge/job-pipeline.git`.

### Pitfalls specific to this project

- **Vite env vars:** only `VITE_`-prefixed vars reach the browser, and Vite inlines them
  at **build** time — after changing them on Vercel you must **redeploy**; a missing
  `VITE_SUPABASE_*` white-screens the app (now guarded).
- **`vercel env add` (non-interactive) silently stores empty values** — set vars via the
  Vercel dashboard or REST API, and verify with `vercel env pull`.
- **Preview deploys share the *production* Supabase DB** — writing/deleting on a preview
  mutates prod data; test destructive actions with throwaway rows.
- **Daytona sandboxes leak disk** unless created `{ ephemeral: true, autoStopInterval: 2 }`;
  `daytona.list()` is an async iterable.
- **Supabase access model:** job ids are text (`job-N`, `live-<ts>`); the browser has
  **read-only RLS**; all writes go through Vercel functions with the service-role key.
- **`seed.py` re-stamps `created_at`** — re-seeding makes every job look "New" (last-7-days);
  re-apply the backdate or bake in a real date.
- **Vercel Root Directory is `dashboard`** — import the existing repo, not a generated template.
- **Vercel counts every `api/*.js` as a serverless function — Hobby cap is 12 per deploy.**
  Co-located test files count too (bit us on 2026-07-10: 13 files → deploy ERROR, prod kept
  serving the old build). `dashboard/.vercelignore` excludes `api/*.test.js`; currently 8
  deployed functions — check the count before adding routes.
- **`sources` bucket must stay private** — no anon storage policies, ever. A public bucket
  or a `kind=cv` route would make stored résumés enumerable (no login, serial cv ids).
- **Current LangSmith run queries are async and projection-based** — `client.runs.query()`
  defaults to a one-day window and returns only ids unless `min_start_time` and `selects`
  are supplied. Live status strings are lowercase even though generated types currently
  advertise uppercase literals; normalize them at the dashboard boundary.
- **W&B Golden runs use local screenshots but never upload them** — set `WANDB_PROJECT`
  as `entity/project`; the guarded runner sends fixture text, hashes, expected/actual JSON,
  scores, and allowlisted metadata only, after every local image has passed SHA preflight.
  `weave` stays a dev dependency, and no deployed API route imports it.

<!-- END PROJECT -->
