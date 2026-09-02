# AGENTS.md

This is the operating manual for any AI agent working in this repo. Read it
before starting. It has two kinds of content: the **way of working** (the same
in every project — follow it as written) and the **project specifics** (the
`<...>` placeholders — particular to this repo). If a placeholder is still
unfilled, say so before relying on it rather than guessing.

---

## Who you're working with

The person you're working with thinks clearly about systems and writes precise
instructions, but does not verify code by reading it line by line. They verify by
*behavior*: by running things, by checking outputs on real inputs, and by
reading your plain-English explanation of what the code does and comparing it to
what they asked for.

What this means for you, always:

- Explain what your code does in plain English, not just by handing over code.
- Show outputs on real inputs whenever you can, and say what those outputs mean.
- Leave behavior inspectable: print or log the intermediate values that would let
  the person — or a later agent — see what actually happened, especially around
  LLM calls and data transforms. A result you can't trace back is one they can't
  trust.
- If your explanation and your code don't match, that's a real problem — stop and
  resolve it, don't paper over it.
- You are not the authority here. You produce a recommendation; the person
  evaluates it. You are sometimes confidently wrong. Expect to be questioned, and
  treat being questioned as normal.

---

## What this project is

**See What AI Employers Want** — a dashboard that reads AI-engineer job-description
screenshots with a vision model, reconciles the messy skill names, and aggregates them
to show what the AI job market is actually prioritizing — by skill, by seniority, and
against your own résumé. Built solo at a one-day hackathon. Full "why" in README.md;
live at https://job-pipeline-opal.vercel.app.

---

## Three documents hold the project's intent

You have no memory of past sessions. Anything not written down does not exist to
you. So intent is kept in three files, and you should read them:

- **README.md** — why this project exists and what it's for.
- **DECISIONS.md** — the choices that have been made and why. Read it before
  proposing anything that might contradict a past choice. If a new proposal does
  contradict one, say so plainly rather than silently overriding it.
- **AGENTS.md** — this file: how to work here.

### First task in a new project: fill the project specifics

When this file is copied into a new repo, the first agent task is to fill the
project-specific sections from README.md, DECISIONS.md, the project brief, and
the actual repo structure.

Do not invent missing details. If the docs do not say something, leave the
placeholder or mark it as unknown.

After filling the sections, present them for review before relying on them. Once
confirmed, commit the filled AGENTS.md before starting feature work.

### Starting each session

At the start of every coding session, read AGENTS.md, README.md, and
DECISIONS.md before proposing work. Then report any unfilled placeholders,
contradictions, missing commands, or project-specific facts you cannot verify.
Do not rely on placeholder text as fact. If the docs are incomplete, say what is
missing and propose the smallest useful next step that does not require guessing.

A normal session-start response should include:

- what you understand the task to be;
- any repo facts or decisions that constrain the task;
- anything missing or ambiguous that affects the work;
- the smallest plan that can be reviewed before code changes begin.

---

## The build loop

Every meaningful change runs the same four steps: **plan → check it in a
notebook → move it into the codebase with a test → commit.** Keep the loop small
so each pass produces something that's actually been checked, not a pile of
unreviewed code.

**What "meaningful" means, and who decides:** default to the full loop for
anything that ships or persists in the repo. You don't get to decide a change is
"too small" for the loop — that judgment stays with the person. They will tell
you when a task is exempt (a throwaway probe, a demo that won't outlive itself,
pure exploration before something is worth building seriously). Until they do,
run the loop.

### 1. Plan before writing code

Every meaningful change starts with a short written plan, before any code. A plan
covers:

- **Purpose** — what this is for.
- **Definition of done** — specific things that must be true to call it finished.
- **Adds / does not add** — what's in scope and, just as importantly, what's
  deliberately left out.
- **Steps** — ordered, with checkpoints.
- **Pitfalls** — known traps to avoid.
- **Budget** — concrete limits for this pass: files touched, sample inputs,
  expected test commands, LLM/API calls, cost-sensitive operations, and anything
  deliberately deferred. Avoid vague time estimates when a mechanical cap would
  be clearer.

The person reviews the plan before you build. If a plan is too long to review
carefully, it's too long to build — make it shorter first. The first plan you
propose is usually too big; expect to be asked what can be cut.

Do not start writing persistent code until the person has accepted the plan,
unless they explicitly asked for a throwaway probe or exploration. If the request
is urgent or clearly scoped, keep the plan very short, but still state it before
changing files.

### 2. Check new behavior in a notebook first

Any new code that produces or transforms data gets built in a notebook before it
becomes part of the codebase. "Notebook" here means a runnable scratch file (a
`.ipynb` or a plain script — either is fine) that lives in `scratch/`, runs, and
shows its output. It is not part of the codebase. In it:

1. Write the function.
2. Call it on real input data from `tests/fixtures/`, not invented. If you have no
   real input, say so and ask, rather than fabricating it.
3. Print meaningful output at each step.
4. Explain in plain English what the output means and what to expect.

The person then compares three things: the output, what they expected, and your
explanation of the output. Bugs usually hide where your explanation and their
expectation disagree. If all three line up, the code moves into the codebase. If
not, expect a specific question before anything moves.

This applies to anything where a wrong result would be hard to spot by eye —
extractors, evaluators, parsers, data transformations. It does not apply to
config changes, simple refactors, or UI work. When you are unsure whether the
notebook step applies, say why and ask before skipping it. Do not silently decide
that risky behavior is "too small" to check.

### 3. Move it into the codebase with a test

Once the notebook shows the code works, move it into its proper file and write a
pytest test that locks in the behavior just verified. The test is not optional.
The notebook proved it worked once; the test proves it keeps working as other
things change. When you move it, say what's moving where and what the test locks
down, so the person can confirm the test matches what was actually checked.

Give the new module a top docstring per the layout rules below (what it does,
what it does NOT do, its invariants). After the move, the notebook can be deleted
or kept as documentation. It is not shipped code.

Tests should cover: schema rules (required vs optional fields, limits, defaults),
plain function behavior, important paths (extraction with the LLM call mocked,
retry logic, what happens when validation fails), and every bug ever found. Tests
should not cover: exact wording of prompts (changes too often), behavior of
libraries you haven't customized, or trivial code. **Always mock LLM calls in
tests — never make real ones.** Tests need to be fast and give the same result
every time.

### 4. Commit rollback-safe checkpoints

A commit is a **known-good recovery point**, not just a record that some work
happened. Keep commits small enough that if the *next* change introduces a bug,
we can return to the previous commit without losing unrelated work or restoring
a half-working state. This is development-scale practice for the same rollback
discipline production systems need.

Each commit should contain one coherent change and everything directly required
for that change to be safely true: implementation, the tests that prove it, and
any tightly coupled schema/docs/decision update. Do **not** split a feature from
its proving test merely to make separate commits; neither is a useful recovery
point alone. Do not bundle unrelated cleanup just because you noticed it while
working.

When a coherent unit of work is complete and verified, and the next action would
begin a separate change, **stop and call out the checkpoint explicitly**. Say:
“This is a clean commit checkpoint,” summarize what would be captured, and
recommend a concise commit message. Do not merely report that files are
uncommitted. If the current state is *not* yet a safe checkpoint, say why and
what remains before it becomes one.

Do not create the git commit unless the person explicitly authorizes it, or the
task already includes commit permission. The agent is responsible for deciding
when a commit is warranted; the person decides whether to authorize it. On
longer work, repeat this at every verified independent checkpoint rather than
letting several changes accumulate into one rollback unit.

### Staying inside the plan

When you spot follow-up work beyond the current plan, name it in your summary and
leave it out of the current change. Don't expand the task to absorb it — scope
creep is exactly what the plan exists to prevent. Surfacing it is enough; the
person decides whether it becomes its own planned change.

### When something fails or the repo disagrees with the docs

Failures are information. Do not hide them, hand-wave them, or keep patching
blindly. When a command fails, a fixture is missing, a test contradicts the plan,
or the repo layout disagrees with AGENTS.md, stop and report:

- the exact command or action that failed;
- the relevant error or mismatch;
- what you think it means;
- the smallest next check or change you recommend.

Do not invent missing fixtures, commands, environment variables, or project
constraints. If a required input is absent, say so and either use the nearest real
fixture with permission or propose adding the missing fixture as its own small
step.

---

## Recording decisions and bugs as you go

The loop produces intent the next session won't have unless it's written down:

- **A decision** (chose X over Y, and why) goes in DECISIONS.md as a few lines:
  the conclusion and the reasoning that still matters — not a transcript. If it
  can't be put in a few lines, it isn't settled yet, so it doesn't belong in the
  file.
- **A fixed bug** becomes two things: a regression test (locks in what broke) and
  a one-line note on why it happened. The test stops that exact bug; the note
  helps stop the whole class of bug.

**Proactively surface decisions.** Do not wait for the person to notice that a
discussion has produced something worth recording. When a meaningful design,
workflow, scope, or trade-off decision appears settled, say so and propose a
short DECISIONS.md entry (roughly 3–5 lines: conclusion + reasoning that still
matters). Treat it as a recommendation only: the person decides whether it belongs
in the log. Do not write it into DECISIONS.md or commit it unless explicitly asked.

Do not put chat transcripts in the repo, and do not try to archive whole
discussions so a future session can "catch up." The repo holds decisions and
reasoning, not history.

**When a decision gets committed depends on when it was made:**

- Decided *before* any code (a discussion that settled a design question): it
  commits on its own, first — there's no code yet to attach it to.
- Decided *during* the work (you hit a fork mid-task and the person resolves it):
  it commits together with the code it affected, since the reasoning and the
  change belong together.

Either way, the rule that matters: the decision must be in the current files
*before* anything depends on it. You read the current files, not the git history,
so timing is what counts — not how the commits are bundled.

---

## Handing off from a discussion to a coding task

Design thinking often happens in a separate chat, away from you. When one of
those discussions settles a decision, the handoff produces **two separate
things** — never one mixed-together blob:

1. **A decision entry** ready to paste into DECISIONS.md. The person confirms it
   says what they meant, then commits it on its own, before any code.
2. **A coding instruction** for you that *points at* that decision rather than
   re-explaining it — e.g. "Per the DECISIONS.md entry on X, refactor Y to…"

The decision is committed first, then you get the coding task. By the time you
start, the reasoning is already in the files you read.

### Command: "prep this for decisions"

When the person says **"prep this for decisions"** (or something close), a
discussion has settled a decision they want to record and act on. Produce the two
separate things above:

1. **Decision entry** — formatted for DECISIONS.md: a few lines, conclusion plus
   the reasoning that survived. Not a transcript. If it can't be stated in a few
   lines, say so — it isn't settled yet.
2. **Coding instruction** — for the next task, pointing at the decision entry
   rather than restating it.

Do **not** write to DECISIONS.md or change code in response to this command. The
person commits the decision entry themselves, then gives you the coding task
separately. This command only produces the two things for review.

Only do this when a decision was actually reached. A discussion that explained
something but settled nothing has nothing to prep.

---

## How you'll be reviewed, and when to expect pushback

When you produce code, the person runs a fixed check: reads the function name and
docstring, asks for a plain-English explanation, checks outputs on real input,
and scans for tells (names that don't match the description, unexplained numbers,
vague logic). For load-bearing code — schemas, evaluation logic, anything that
transforms data — expect to be asked to critique your own work and call out edge
cases.

Expect pushback when any of these is true. Treat each as a signal to slow down and
explain, not to defend:

- Your proposal contradicts a recorded decision in DECISIONS.md.
- You're adding a dependency or an abstraction for something used only once.
- The work has grown past what the plan said.
- There's a number, retry count, or limit with no stated reason.
- Your plain-English explanation doesn't match the code you wrote.

### Reading a function together

Once a session, the person may pick one function you wrote and read it line by
line, asking you to explain as they go. When this happens, explain plainly and
honestly, one line at a time — this is how they build their own ability to read
code, so don't rush it or skip ahead.

---

## How this project is built and laid out

### Filling in the project specifics (once, at launch)

Everything below this line, plus "What this project is" near the top, are the
project-specific parts of this file. Fill them from the project brief and
README — don't invent.

- **What this project is / Stack / Running and testing:** transcribe from the
  brief. Keep "What this project is" a *pointer* at README, not a paraphrase of
  it — less to drift.
- **Where things live:** scaffold from the intended layout, but this section
  describes the repo as it *is*, not as it's planned — keep it updated whenever
  files move. `scratch/` and `tests/fixtures/` are fixed; fill in the rest.
- **Pitfalls:** record only pitfalls the brief explicitly names or that have
  actually been hit. Do not generate plausible-sounding ones — an invented
  pitfall is noise the agent will then treat as a real constraint. This accretes
  over time like DECISIONS.md; near-empty at launch is correct.

After filling these, present the filled sections for the person to confirm before
relying on them. The fill is a draft to confirm, not a fact to accept.

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
- **Deploy:** Vercel (push to `main` auto-deploys; project **Root Directory = `dashboard`**).

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
  links database jobs to their local screenshots.
- `streamlit_app.py` / `langsmith_dashboard_view.py` / `langsmith_dashboard.py` — local,
  read-only LangSmith evaluation UI, pure presentation transformations, and the guarded
  data/comparison boundary. They do not run experiments or write to LangSmith;
  `tests/fixtures/langsmith_experiment_snapshot.json` retains the sanitized real SDK
  shapes used by the mocked pytest suite.
- Other docs: `ARCHITECTURE.md`, `jd-aggregator-sprint-plan.md`
  (design/spec detail beyond README).
- `scratch/` — where step-2 notebooks live; gitignored, not shipped code (fixed
  convention across projects — don't rename it)
- `tests/` — pytest suite; JS tests live next to their modules in `dashboard/` and run
  through Vitest.
- `tests/fixtures/` — real/sample inputs for step-2 checks and review (fixed convention
  across projects — don't rename it). Holds `sample_extracted.json`, `golden_jobs.json`,
  and `golden_canonicalMap.js`.

Three layout rules:

- Imports flow one direction — lower-level files don't import from higher-level
  ones.
- Functions that mix input/output with logic get split into pure logic plus a
  thin I/O wrapper. The pure part is what gets tested.
- Every module gets a top docstring: what it does, what it explicitly does *not*
  do, and the invariants it holds. The "does not" line is the one that matters —
  it's the boundary that keeps code from landing in the wrong place.

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
