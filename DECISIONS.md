# Decisions Log

A plain-English record of the meaningful calls we've made on this project: what we
decided, why, what we tried, and what **didn't** work. The point is so that a future
person — or a future AI agent — can read this and avoid re-treading dead ends or
undoing a decision without knowing the reason behind it.

**How to use this file**
- Newest entries first.
- Each entry: date + time, a short plain-English note, and (where relevant) the
  trade-off or the thing we tried that failed.
- Times are when the decision was committed to git (so they're accurate, not guessed).
- If you're an agent picking this project up: read this before changing extraction,
  normalization, or the deploy setup. Several things here were already tried.

---

## 2026-08-17 — Keep non-skill requirements; score alternatives as one criterion

The extraction contract now separates technical skills from education, experience,
credentials, soft skills, and responsibilities. The non-skill mentions are preserved
on the job record as structured audit data, rather than discarded, so later features
can use them without re-reading a screenshot. They never enter the skills chart or
résumé match.

An explicit alternative such as “Python or Java” becomes two skill records in one
alternative group. The skills chart keeps its existing document-frequency rule and
counts both mentioned skills; résumé matching and tailoring treat the group as one
criterion, satisfied when the candidate has either member. This prevents a candidate
with Python from being penalized for not also having Java.

---

## 2026-08-15 — Download a copy of the screenshot (lightbox save button)

**Feature:** The screenshot lightbox (both the job-row one in `App.jsx` and the
tailor screen's left pane) gained a corner **⤓ Download** button that saves the
original JD screenshot to disk.

**The load-bearing detail:** an `<a download>` attribute does **nothing** here —
browsers ignore it when the href points at another origin, and our signed URLs
are served by Supabase Storage, not by us. So the save has to come from the
server: `GET /api/file?...&download=1` now asks `createSignedUrl` for a
`{ download: <filename> }` URL, which makes Storage return
`Content-Disposition: attachment`. Plain navigation to that URL downloads
without leaving the page.

**Scope calls:** download is a **separate request** returning a second signed
URL, not an extra field on the view response — one storage call stays the cost
of just looking. The attachment filename is the **basename of the stored path**
(`live-123.png`), never the query string, keeping storage-blueprint's "keys and
names are server-generated" invariant; `download` is accepted only as the exact
value `1`. Same 3600 s TTL, same screenshot-only kind allowlist — this widens no
access (D1 untouched; CVs still have no read path).

**No new serverless function** — the client helper lives in `src/downloadShot.js`,
so the Hobby 12-function cap (07-10 gotcha) is untouched.

**Verified:** full vitest suite green (199, of which 8 are new — 5 in
`src/downloadShot.test.js`, 3 in `api/file.test.js`), `vite build` green,
`eslint` unchanged from its 2 pre-existing errors. **Not yet
verified live** — the actual browser save needs a deployed row with a stored
screenshot.

---

## 2026-07-23 — Email fetch: keyword-scan the whole inbox, not a curated label

Reversed the spec's original curated-fetch decision. The spec chose
`GMAIL_QUERY = "label:job-search"` — only manually-labelled mail enters the
pipeline — for precision. In use that's wrong: the point is to *discover* job
emails automatically, and hand-labelling every one defeats it.

New design: **broad keyword net over the whole inbox + classifier as the filter.**
- `config.GMAIL_QUERY` is now a high-recall Gmail keyword query (interview,
  application, candidate, role, position, hiring, offer, + ATS platforms like
  greenhouse/lever/ashby/workday). No label, no time bound (add `newer_than:Nd`
  to bound it).
- Two stages, deliberately different: **Gmail = literal keyword match, no
  judgement** (its only job is to over-fetch candidates); **Haiku classifier =
  semantic judgement** (decides real category vs `other`). Paraphrase variance
  ("move forward with the process" vs "move you forward in the process") is
  resolved by the LLM, not by search terms — so outcome phrases are NOT search
  terms.
- The pipeline **drops `other`**: an email the classifier calls not-a-job is
  counted in `RunReport.dropped` and never stored, so the net's false positives
  don't become noise rows. `recruiter_outreach` keywords dropped (not happening
  for this user; would be LinkedIn anyway) — the category stays in the classifier.

Tradeoff accepted: a broad net over a full inbox fetches extras → more LLM calls
(~2/email). Precision is free (classifier filters), you pay to judge the noise.
If a first run fetches a huge pile, tighten toward the distinctive terms
(interview, candidate, ATS domains) or add `newer_than`.

Consequence: `GmailSource` needs a real token, and first-run consent wasn't wired
(it only *loaded* a token). Added `scripts/gmail_auth.py` (one-time InstalledApp
consent) + `scripts/run_parser.py` (local hand-triggered run). Still a laptop job;
a server-side `/api/refresh` button is a later phase.

---

## 2026-07-23 — Matcher: duplicate applications to the same role go unlinked

Decision: accept that re-applying to the same role at the same company produces
two near-identical job records that the matcher cannot distinguish. Both survive
the role-token tiebreak, so the result is ambiguous and `match()` returns None.
The application email links to nothing.

Why accept it now: at current corpus size (~20 jobs) re-applications are rare,
and the failure is silent-but-safe — an unlinked record, not a wrong link. The
matcher's conservative bias (never guess when ambiguous) is working as intended.

Why it will need revisiting: expected to bite at ~60–100 jobs, when re-applying
to previously-seen companies with a stronger résumé becomes routine. The
frequency scales with corpus size; the failure mode does not change.

Likely fix when it does: recency tiebreak — prefer the candidate whose record is
closest in time to the email's received date. Deferred, not designed.

Related: company matching is exact string equality on the normalized name (no
canonicalization, per the T2 normalize decision). Verified against the current
jobs snapshot: zero records fail to produce candidates, so canonicalization is
not needed today. Revisit if a source writes company names differently —
Gmail sender names or a bulk import are the likely triggers.

---

## 2026-07-14 — Root cause: normalize.py's determinism bug shipped because sprint AGENTS.md waived tests

Traced *why* `normalize.py`'s nondeterminism (the hash-randomized `clean_variants` tiebreak,
fixed 07-07) shipped and sat unseen for ~2 weeks. It was not carelessness — it was the
governing rule at the time. The hackathon `AGENTS.md` (the "sprint variant", commit 2039a3d)
deliberately dropped the test suite: *"No test suite this sprint; verification is by eyeballing
output on real inputs."* So normalize.py went to `data`/`jobs.json` on an eyeball check only —
and eyeballing can't catch a bug that only surfaces across separate process runs (set-iteration
order is stable within one process, so the CLI output looked consistent every time it was
checked by hand).

**Why it wouldn't happen now:** the current `AGENTS.md` (graduated to the full build loop on
07-07/07-08) makes the test non-optional — step 3, "move it into the codebase with a test,"
plus *"tests need to be fast and give the same result every time."* Under that rule normalize.py
can't leave `scratch/` without a pytest test, and a golden test run in a fresh process trips the
tiebreak flake on day one — which is exactly how it *did* eventually get caught, once the tests
existed. Same class of bug; current rules catch it at authoring time, not two weeks later during
an unrelated refactor.

**Takeaway:** the sprint-mode "eyeball, no tests" waiver was the right speed trade for one day,
but it's a determinism blind spot — cross-process nondeterminism is invisible to eyeballing by
construction. Any future time-boxed variant that re-drops the suite carries the same risk.

---

## 2026-07-14 — Tailored-résumé v1 live-verified (T10); judge caught real over-attribution

Full pipeline verified against production: transcribe (cv 19) → split (8 sections) →
generate (job-1, verified:true) → organic guard fires → docx. Two things worth remembering:

- **The guards fired for real, unprompted.** The judge failed the FIRST live generation
  for over-attribution (model claimed template projects as first-person work); one retry
  with the objection fixed it. Digit-diff separately caught a foreign "19". Deliberate
  attacks (fabricated metrics, bogus claim ids) never got past the prompt layer, so the
  hard-422 path remains unit-proven only — recorded honestly in the loop log.
- **Template claims should be written first-person.** The judge reads "Built X using Y"
  third-person claims as unattributed references, not the candidate's own work — reword
  `project_template` claims (or prefix attribution) so Projects bullets can actually use
  them instead of leaning solely on the résumé's original text.

Prompt cache verified live (2908-token prefix, write-then-read). Artifact:
`scratch/resume-job-1-t10.docx` — open in Word for the final manual check.


## 2026-07-13 — Tailored-résumé architecture: Provenance Pipeline (proposal B)

Chosen over "lean human-gate" (A) and "layout-faithful template" (C — deferred as
presentation-only value blocked on a .docx source we don't have; base résumé is a PDF).
Reasoning that survives: research showed every commercial tool fabricates metrics and
prompt-only "don't invent" fails — so honesty must be machine-checkable, not procedural.
Each generated bullet carries `claim_ids` (code-validated), a digit-diff regex flags any
number not present in the confirmed claims, and a Haiku-tier entailment judge gates each
section with one auto-retry. Sub-decisions: per-bullet claim granularity; judge failure
renders with an "unverified" badge rather than blocking (fail-visible beats fail-closed
for a single-user tool); export uses a clean single-column house template (best ATS parse
rates), not the user's original layout. Full trade-offs:
`sigma/specs/tailored-resume/proposals.md`; research basis:
`sigma/specs/tailored-resume/research.md`.

---

## 2026-07-13 — CV retrieval stays off the public route

`api/file.js` allowlist is screenshot-only **by design** — résumé fetch uses a
service-role probe, not a signed URL. (Grill round-2 HIGH: plan step 7 still said
"signed URL fetch returns the PDF," which would tempt a verifier to widen the
allowlist and reopen the sequential-cv-id enumeration hole D1 closed. Step 7
rewritten in `source-file-storage-plan.md`.)

---

## 2026-07-10 — Corpus screenshots backfilled (storage + hashes); legacy dedup hole closed

One-off migration (`scratch/backfill_screenshots.mjs`, dry-run then live, idempotent):
all 20 corpus screenshots uploaded to `sources/screenshots/<job-id>.png` and their rows
stamped with `screenshot_path` + SHA-256 `screenshot_hash` — mapping taken from
`data/extracted.json`'s `source_file`. No `created_at` touched (seed-restamp trap avoided);
no hash collisions with live rows. Verified: 21 rows with path+hash, 21 bucket objects,
deployed `/api/file` serves job-1's image (200, 105 KB).

Corpus rows now show "View screenshot" and are visible to hash dedup. Remaining known gap:
3 pre-dedup live drop-ins (Enpal, eduBITES, POS TUNING) stay hashless — their original
files are gone; a re-upload of the same screenshot file would not be caught for those.

---

## 2026-07-10 — Source-file storage v1 SHIPPED and verified on prod

All 7 plan steps done (`source-file-storage-plan.md` + `storage-blueprint.md`).
New drop-ins store their screenshot (`sources/screenshots/<job-id>.<ext>`), new résumé
uploads store their PDF (`sources/cvs/<id>.pdf`, capture-only), expanded rows with a
stored screenshot get a "View screenshot" lightbox via `GET /api/file` (signed URL,
3600 s, screenshot-only per D1), and deleting a row removes its file by prefix.
61 vitest green (storage/LLM mocked); deployed verify: BJAK drop-in → button → image,
cv 19 → `cvs/19.pdf` in the bucket, `kind=cv` → 400 on prod.

**Deploy gotcha (bit us):** Vercel counts **every** `api/*.js` as a serverless function
— including co-located `*.test.js` — and the Hobby plan caps a deployment at 12. Our 5
new test files made 13 → deploy failed with `exceeded_serverless_functions_per_deployment`
(prod kept serving the old deployment; the site never broke). Fix: `dashboard/.vercelignore`
excludes `api/*.test.js` from the upload (8 deployed functions). Adding a 5th real route
+ tests will hit this again — watch the count.

**Data notes from the same session:** the `cv` table was found empty on 07-10 (DECISIONS
07-08 said 2 rows remained; id sequence continued normally, so rows were deleted via
ordinary deletes — cause unknown, not the ALTER). Re-uploads recreated rows 17/19. Two
all-null jobs from 07-08 evening (bad parses persisted — extract.js has no minimum-viability
gate; possible future guard) were user-deleted.

---

## 2026-07-10 — Storage v1 design locked (grill → blueprint); public CV retrieval cut from v1

An adversarial grill of `source-file-storage-plan.md` (round 1, verdict BLOCK: 2 HIGH)
led to `storage-blueprint.md` — components, ordering contracts, and four design
decisions, all accepted:

- **D1 (the material one):** `api/file.js` serves **screenshots only** in v1. The
  planned `kind=cv` signed-URL route would have made every stored résumé publicly
  enumerable — the app has no login and cv ids are small sequential integers, so the
  "private" bucket was privacy theater. Résumés are still *stored* (capture-only);
  retrieval ships with the tailored-résumé feature once an access story exists.
  Screenshots stay retrievable — they're public job ads.
- **D2:** the screenshot upload is response-critical: it runs before the row insert
  and the JSON response, and `screenshot_path` rides both — same bug class as the
  07-08 `created_at` miss (field absent from the API response → feature dead until
  reload), and post-response work can silently never run on Vercel.
- **Orphan rule:** deterministic storage prefixes (`screenshots/<job-id>.`,
  `cvs/<id>.pdf`) + delete-time remove-by-prefix regardless of a null path column.
- Smaller: media-type allowlist → fixed extensions (no client strings in storage
  keys); signed-URL TTL pinned at 3600 s.

Plan text updated to match. Design trail: `storage-blueprint.md`.

---

## 2026-07-08 — ⏸ Resume point: source-file storage plan drafted and reviewed, build not started

**Where things stand:** Search-by-company + soft duplicate warning are built, tested,
deployed, and user-verified live. Next planned change is `source-file-storage-plan.md`
(store JD screenshots + résumé PDFs in a private Supabase Storage bucket; "View
screenshot" button; generic signed-URL route). The plan was redrafted to fold in the
résumé-PDF extension because `tailored-resume-plan.md` (user-authored, in repo) needs
both artifacts — sequencing: storage v1 → corpus-screenshot backfill (also closes the
legacy hashless-dedup hole) → project-template synthesis → tailored résumé.

**On return, start at plan step 1:** create the private `sources` bucket + add
`job.screenshot_path` / `cv.pdf_path` columns (by hand in the Supabase dashboard/SQL
editor — agent preps the SQL, person runs it). Nothing is half-built; no code for this
plan exists yet.

---

## 2026-07-08 — Job search by company (v1)

**Feature:** A search input in the Jobs panel header filters the job list by company name —
case-insensitive substring, whitespace-trimmed. Pure `filterJobsByCompany` in its own module
(`src/searchJobs.js`, unit-tested). **Scope calls:** v1 is company-only (title/skill search
deferred); search scopes the *list only* — chart and stats stay global, same idiom as the
skill/seniority filters. An active search auto-reveals older matches (they'd otherwise hide
behind the new-only collapse) and hides the Show all/less controls; clearing restores the
default view.

**Why:** The Mercanis double-upload showed there's no way to check "do I already have this
company?" before uploading. Search is the cheap manual guard (the automatic one is the soft
duplicate warning, next entry).

**Verified:** vitest green (5 filter tests), `vite build` green, headless-Chrome screenshot of
the header input rendering against real data.

---

## 2026-07-08 — Soft duplicate warning on drop-in (dedup v2, client-side)

**Context:** The same Mercanis posting got in twice — the hash dedup (v1) only blocks a
byte-identical re-upload; a *new screenshot of the same posting* has a different hash and sails
through. Fully fuzzy posting-identity matching is unbounded; same-company is the cheap,
high-signal check.

**Feature:** After a successful parse, the client checks the new job's company against the
existing list (`findSimilarJob` in `src/similar.js` — case-insensitive, trimmed, newest match
wins). On a hit: a **non-blocking** softer-amber banner — "Added — but this may duplicate
{company · title} (click to compare)" — with the same reveal-on-click + dismiss behavior as the
hard-dup banner. The job is still added; the user decides. Deliberately coarse: a false
"possible duplicate" costs one glance, a missed one skews the chart.

**Verified:** unit tests (5) + `vite build` green. The full upload→banner flow needs a live
Daytona parse — confirm on the deployed site with the next real upload.

---

## 2026-07-08 — 2026-07-07 "regressions" investigated: one real bug (fixed), one known scope limit, one not reproducible

Three core features reported broken on the live site on 07-07. Investigated read-only against
prod (Supabase REST via anon key, deployed function probes, deployed-bundle grep). Baseline
finding: **the last two 07-07 commits (the normalizeSkills DRY refactor + its tests) were never
pushed** — the deployed site runs pre-refactor code, so the refactor is ruled out as a cause.

1. **"New" badge missing after a drop-in — real bug, now fixed.** `api/extract.js` never
   returned `created_at`, and `isNewJob()` keys off it — so a freshly uploaded job showed no
   New badge until a reload (the reload reads Supabase, which has the column default). Fix:
   stamp `created_at` server-side so it's both persisted and returned. Locked by new handler
   tests (`api/extract.test.js`, Daytona mocked): fresh ISO timestamp, `live-` id,
   `screenshot_hash` stripped, skills normalized. **Committed but not yet pushed/deployed.**

2. **Duplicate not caught (ClickHouse uploaded twice) — v1 scope limit, not a code bug.** The
   first ClickHouse upload (07-07 08:10 UTC) landed *before* the dedup deploy went live — its
   row has a **null** `screenshot_hash`, so the 12:24 UTC re-upload had nothing to match and
   sailed through (the 12:24 row *did* get a hash, so a third upload would 409). This is the
   documented v1 limitation: hash-less legacy rows are invisible to dedup. Both ClickHouse
   rows are still in prod (`live-1783411808718` hashless, `live-1783427074891` hashed) —
   deleting one is a manual call, not done here.

3. **CV uploader — could not reproduce; deployed path verified healthy today.** Full
   end-to-end test against prod with a throwaway synthetic PDF: `POST /api/resume` → HTTP 200
   in ~7s, correct profile (incl. the inferred-LLMs rule), persisted as cv id 12, then deleted
   via `/api/cv` (only the 2 original CVs remain). Frontend wiring (`handleResume`) reads
   correct. Whatever failed on 07-07 was transient (Daytona/Anthropic hiccup?) or a symptom
   not yet described — if it recurs, capture the exact on-screen error and check the Vercel
   function logs before touching code.

---

## 2026-07-07 — normalize.py made genuinely deterministic (+ pure-function refactor)

**Refactor:** Split the normalization logic out of `normalize.main()` into pure, testable
functions (`build_display`, `resolve`, `clean_variants`, `normalize_jobs`, `build_canon_map`)
per AGENTS.md's layout rule; `main()` is now a thin read→normalize→write wrapper.
Behavior-preserving, guarded by a golden characterization test.

**Bug the golden test caught:** `normalize.py`'s docstring claimed "same input, same output,
every run" — but it wasn't true. `clean_variants` sorted the "merged from" variants by
length only; for two variants of equal length and same lowercase (e.g. `"Tool Use"` vs
`"tool use"`), which spelling survived depended on Python's per-process **set-iteration order**
(hash-randomized), so `jobs.json`'s `skill_variants` varied run to run. It only looked stable
because the tie is rare — the golden test failed in a fresh pytest process while the CLI runs
happened to agree.

**Fix:** deterministic tiebreak — `sorted(raws, key=lambda r: (len(r), r))` instead of
`key=len`. Equal-length variants now break alphabetically. Output is unchanged vs the committed
`jobs.json` (which already had the alphabetically-winning spelling) — the fix just guarantees it
every run. Locked by unit tests + a golden fixture; verified green across repeated fresh processes.

---

## 2026-07-07 — Delete job listings

**Feature:** Delete a job from the dashboard. In the expanded job row, a red-outlined
**Delete** button reveals a two-step inline confirm ("Delete this job? Delete / Cancel") —
deliberately gated behind expand + confirm since it's a permanent Supabase delete.

**How:** New server route `api/job.js` (`DELETE ?id=`, service-role key — browser has
read-only RLS) deletes the `skill` rows (FK `job_id`) then the `job` row. Front-end
`deleteJob()` is optimistic: drops it from `data.jobs` immediately, rolls back + shows an
error line if the request fails, and clears any dangling reference (upload card / dup
banner) to the deleted id. Same pattern as the saved-résumé delete.

**Verified:** `vite build` green; the exact delete ops (insert job+skills → delete skills →
delete job → no orphans) run against the real schema via a throwaway row; screenshotted
both the button and the confirm state (only clicked the first Delete, no real deletion).

## 2026-07-07 — Duplicate-screenshot detection by file hash (v1)

**Feature:** Block re-uploading the same JD screenshot. `api/extract.js` computes a
SHA-256 of the screenshot bytes **before** the Daytona parse and looks it up in
`job.screenshot_hash`; an exact match returns HTTP 409 with the existing job's
`{id, company, title}` and **no sandbox is created** (no wasted parse). No match →
parse, then persist the job with its hash. The dashboard shows a **persistent amber
banner** under the upload button — "⚠ Already added — {company · title}" (fallback "a job
already in your list" when both null) — that stays until dismissed or the next upload.
It does **not** auto-scroll; only clicking the banner's link expands + scrolls to +
pulses the existing row.

**Storage:** No interim store needed — persistence already shipped. Added `screenshot_hash
text` to the `job` table with a **UNIQUE** index (`job_screenshot_hash_key`) to close the
pre-check→insert race; the loser of a race re-queries and also returns 409. Nullable +
Postgres NULL-distinct, so the 22 hash-less legacy rows don't collide. Migration run by
hand in the Supabase SQL editor (no POSTGRES_URL locally for DDL).

**Scope (v1):** exact file hash only. A different screenshot of the same posting (different
crop/scroll/compression) has a different hash and is NOT caught — no fuzzy
company/title/seniority matching. Legacy rows have null hashes so only post-ship uploads
are deduped.

**Verified:** `vite build` green; SHA-256 determinism unit-tested. Full upload→409→reveal
needs the live Daytona parse — tested on the preview after the migration.

## 2026-07-06 — Per-row résumé compare (reveal on expand)

**Feature (additive):** Expanding **any** job row now shows how the selected résumé
compares to that job ("Your résumé — N%" + have/missing chips) at the top of the detail,
above the existing summary/skill list. No upload needed; works on every job in the list.
Chosen affordance: reveal-on-expand (no per-row button clutter, reuses the existing click).

**How:** Extracted the have/missing chips into a shared `<MatchChips>` component used by
both the post-upload card and the row; hoisted the résumé skill-set to one `resumeSet`
passed into each `JobRow`, which runs the existing `matchJob()`. Upload card behavior
unchanged. Only shows when a résumé is loaded.

**Verified:** `vite build` green; drove the real app headless — expanded a row with the
auto-loaded saved résumé and captured the match (14%, Python matched, rest missing).

## 2026-07-06 — Instant résumé-vs-uploaded-job comparison

**Feature:** After a JD screenshot drop-in, an inline comparison card appears at the top
("Your résumé vs {company} — {N}%") with green "have" chips and dashed "missing" chips
for the job's REQUIRED skills, so you see your fit immediately. Dismissible; if no résumé
is loaded it prompts to upload one.

**How:** Extracted the per-job match math (required skills the résumé has vs lacks + a
coverage %) into a reusable `matchJob(job, resumeSet)` helper and DRY'd the existing
résumé-ranking `useMemo` to use it. `handleUpload` stashes the parsed job in
`lastUploadedJob`; the card reuses the same `.chip.have/.miss` styles as the résumé
section. Purely client-side — no new API surface.

**Verified:** `vite build` green; unit-tested `matchJob` (75% on 3/4 required, nice-to-have
excluded, empty-required → no chips); card visual rendered with the real CSS. The full
upload→card flow (live Daytona parse) is best confirmed on a preview.

---

## 2026-07-06 — Jobs list: "New" (last 7 days) + progressive disclosure

**Feature:** Renamed the meaningless **Live** badge (it keyed off an `id` prefix) to
**New**, defined as `created_at` within the last 7 days. The Jobs list now shows **only
New jobs by default**; a "Show all N jobs" / header chevron reveals the rest, paginated
`JOBS_PAGE = 20` at a time ("See more" appears only when there are >20 *older* jobs — New
jobs are pinned on top and excluded from pagination so recent adds never get buried).
Header gained a subtle "N new" hint. Replaces the earlier full-collapse behavior.

**Data change (applied, not code):** the 20 seeded `job-*` rows all had `created_at` ≈
2026-07-01 (when `seed.py` ran) — a load-time artifact, not a posting date — so *every*
job counted as "New" and the feature was degenerate. Per approval, backdated each seed
row by −20 days (→ 2026-06-11) via service-role PATCH, **preserving relative order**.
Now only the two real drop-ins (eduBITES, Enpal) are New. Live drop-ins keep their real
`created_at`. If the corpus is ever re-seeded, seed.py will re-stamp today's date — either
re-run this backdate or set a sensible `created_at` in the seed itself.

**Verified:** `vite build` green; headless-Chrome screenshots of both states against real
data (default = 2 New + "Show all 22 jobs"; expanded = 22 with New pinned + "Show less").

---

## 2026-07-04 — Saved résumés: rename + delete, and name-by-filename

**Feature:** The saved-résumé chips can now be **renamed** (✎ → inline input, Enter/blur
saves, Esc cancels) and **deleted** (×). New uploads are named after the **uploaded file**
(extension stripped) instead of the old `title — date`.

**How:** The browser has read-only RLS on `cv`, so writes go through a new server route
`dashboard/api/cv.js` (`PATCH {id,name}` rename, `DELETE ?id=` remove) using the
service-role key — same "writes are server-side only" pattern as extract.js/resume.js.
`resume.js` now takes the filename from the client and derives the name. Front-end
rename/delete are optimistic with rollback; deleting the active résumé falls back to the
next saved one. Existing rows keep their old names (only new uploads use the filename).

**Verified:** `vite build` green; the exact DB ops (insert → update name → delete) run
against the real `cv` table via a throwaway row (id integer, not UUID). Tested on a
Vercel **preview** deploy before prod.

**Gotcha (important):** `vercel env add <NAME> <env>` non-interactively stores an **empty
value** in this environment — both piped (`printf | ...`) and file-redirect (`... < f`)
forms report "✓ Added" but the value is `""`. This bit us on the VITE_ vars too
(2026-07-03). Reliable paths: the Vercel **dashboard**, or the **REST API**
(`POST /v10/projects/{id}/env?teamId=...` with `{key,value,type:'encrypted',target:[...]}`
using the token in `~/Library/Application Support/com.vercel.cli/auth.json`). **Always
verify with `vercel env pull` afterward.** Preview env needed `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` added (they were Production-only).

---

## 2026-07-03 13:12 — Deployed frontend was blank: missing VITE_ env vars on Vercel

**Symptom:** Live site (`job-pipeline-opal.vercel.app`) served HTTP 200 but rendered a
blank page. This is the Part 1.5 "pending deployed verify" resolving.

**Root cause:** The Supabase integration on Vercel auto-added a pile of env vars
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_SUPABASE_*`) — but the dashboard
is a **Vite** app, and Vite only exposes vars prefixed with `VITE_` to the browser.
`dashboard/src/supabase.js` reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, neither
of which existed. So `createClient(undefined, undefined)` threw at module load, before
React rendered → white screen. Confirmed by grepping the built bundle: no `supabase.co`
URL was in it.

**Fix:** Added `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Production) with the
values from local `dashboard/.env`, then **redeployed** (Vite inlines env at *build*
time, so setting them without a rebuild does nothing). Verified end-to-end: new bundle
contains the URL + publishable key, Supabase REST returns HTTP 200, and `content-range:
0-19/20` confirms all 20 seeded jobs reach the anon browser client.

**Gotchas for future-you:**
- Adding env vars requires a **redeploy** to take effect for Vite/Vercel.
- `npx vercel env add NAME production` fed from a pipe **silently stored empty values**
  (reported "✓ Added" but the value was `""`). Setting these via the Vercel **dashboard**
  UI is the reliable path; if scripting, verify with `vercel env pull` afterward.
- The local anon key is the new short `sb_publishable_…` format, not the long legacy JWT
  that the integration stored under `SUPABASE_ANON_KEY` — both are valid for the project.
- Same Supabase project either way (host `mnfqhklvzeorvwjwrzro`), so the seeded data was
  never in doubt — only the frontend's ability to reach it.
- **Latent risk:** `supabase.js` calls `createClient` with no guard, so a missing env var
  white-screens the whole app instead of falling back to `jobs.json`. Worth a guard.

---

## 2026-07-02 08:10 — Part 1.5 (Supabase persistence) code-complete; PENDING deployed verify

**⏸ Resume point.** All 6 Part 1.5 steps are built, committed, and pushed (schema + RLS, `seed.py`,
React reads jobs from Supabase, persist JD drop-in in `extract.js`, persist résumé in `resume.js`,
CV toggle in `App.jsx`). Each verified **locally**: read path via the publishable key, write path via
the secret key, `npm run build` green. Local dev reads from Supabase; the **deployed** site is still
on the `jobs.json` fallback because the Vercel env vars aren't set yet.

**To finish (do this on return):**
1. Add 4 env vars in Vercel (all environments): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. (`VITE_` = build-time; the others = function runtime.)
2. Redeploy (env vars only take effect on a new deploy).
3. Verify the deployed loop: (a) dashboard reads jobs from Supabase (bundle contains the Supabase URL),
   (b) a live drop-in job survives a hard refresh, (c) a résumé saves and the toggle switches between
   saved CVs.

Nothing else is half-done; safe to pause here.

---

## 2026-07-01 15:09 — Supabase (Postgres) chosen as the persistent store

Adding persistence under the two live features (JD drop-in, résumé match) — results currently live
in React state and die on refresh. **Supabase (Postgres)** chosen to hold jobs, skills, résumé
profiles, and (future) applications.

**Over the alternatives:**
- **Vercel KV** — key-value, wrong data model (ours is relational).
- **Turso** — weaker Python client story for the extraction side.
- **SQLite** — Vercel's filesystem is ephemeral; serverless functions can't persist writes to it.

Both `supabase-py` (Python) and `@supabase/supabase-js` (React) are first-class. The existing
`job`/`skill`/`application` schema drops into Postgres unchanged; part 2's email parser writes
`application` rows joined on `job_id` — one query gives the full picture. **No new host** — Supabase
is called from the existing Vercel functions and the React app. The Daytona extraction pipeline is
**unchanged**; only a write-to-Supabase call is appended after the sandbox returns.

---

## 2026-06-26 15:27 — Daytona disk-limit leak fixed (sandboxes now ephemeral)

**Symptom:** live uploads started failing with "Total disk limit exceeded. Maximum allowed: 30GiB."
mid-event.

**Cleared the backlog:** 10 leaked sandboxes deleted via `daytona.list()` + `daytona.delete()`.
(Gotcha: `list()` is an **async iterable** — must use `for await (const s of daytona.list())`, not
a plain for-of; it looks like an empty object otherwise.)

**Root cause:** Daytona's `autoDeleteInterval` **defaults to disabled**, and `autoStopInterval`
defaults to 15 min. Our functions delete the sandbox in a `finally`, but any invocation that didn't
reach it (Vercel timeout, error, or overlapping requests during the demo) left a stopped-but-not-
deleted sandbox holding disk → they piled up to the 30 GiB cap.

**Fix:** create sandboxes with `{ ephemeral: true, autoStopInterval: 2 }` in both `extract.js` and
`resume.js` — a leaked sandbox auto-stops after 2 min idle and then auto-deletes itself. Explicit
`delete()` kept for the fast happy path. Lesson: with on-demand sandboxes, never rely on explicit
cleanup alone — set an auto-delete TTL as the safety net.

---

## 2026-06-26 14:06 — Resume-match stretch: backend built & proven (Steps 1–2)

New additive stretch: upload your own resume (PDF) → see which jobs you match, ranked, with
matched/missing skills. Plan in `resume-match-plan.md`. Gated like the JD drop-in — the
deployed product never depends on it.

**Input = PDF (verified the right call).** The Messages API reads PDFs **natively** via a
`document` content block (no PDF-parsing code, no beta header; 32MB/600-page limits, our
sonnet-4-6 is 1M-context). Earlier I'd rated PDF "high risk" assuming a parsing step — that
assumption was wrong; PDF is nearly identical effort to the proven image path.

**De-risked on a real CV (Step 1, `scratch/resume_probe.mjs`):** PDF base64 (~109KB) embeds
into the Daytona sandbox code string fine; the `document` block works through the sandbox's
stdlib-urllib call; resume prompt returns sane technical skills, no soft-skill noise.

**Backend built & proven (Step 2, `dashboard/api/resume.js`):** SEPARATE file from
`extract.js` so the working drop-in can't regress. Reuses `canonicalMap.js` + the same
normalize logic. Run locally through the real handler on the CV → HTTP 200 + normalized
profile whose canonicals (RAG, AWS, Evaluation, APIs, Vector Databases) match the job
vocabulary. Simulated match: 13 of ~25 resume skills hit a REQUIRED job skill.

**Contract:** `POST /api/resume {pdf, media_type}` → `{profile:{title,
years_experience, skills:[{canonical, raw_text}]}}`. (Route is `/api/resume` — Vercel routes
by filename; the plan's earlier `/api/match-resume` name was wrong.) Match runs client-side
against jobs.json.

**Decisions:** score = % of a job's REQUIRED skills the candidate has (extra skills never
hurt the score); resume skills matching no job shown as an honest "extra skills" line.

**Step 3 done — deployed path verified:** deployed `POST /api/resume` → HTTP 200 + profile
(~11s). Same pass confirmed the existing `POST /api/extract` is also healthy deployed
(Netconomy job, 200, ~17s) — resolves the prior "ANTHROPIC_API_KEY deployed path untested"
note from the 12:37 entry.

**Step 4 done — front-end built & match logic verified:** PDF upload section + client-side
ranking (score = matched/required, top 6) + matched/missing chips + "extra skills" line, all
appended below the existing dashboard (touches nothing above). Match logic verified on real
data: top match "AI Application Engineer" 75%, ranking degrades sensibly, all 20 jobs ranked.

**"LLMs" inference — RESOLVED (deterministic code rule).** Problem: "LLMs" rarely appears
literally on a résumé even when the candidate clearly does LLM work, so it showed as *missing*
on ~19/20 jobs. Chose the **code rule over a prompt nudge** — the project's normalize-in-code
principle (09:26) distrusts prompt-based inference because it's nondeterministic; the same
"infer from other skills" goal done in code is consistent every run. `addInferredLLMs()` in
`resume.js`: if the résumé carries a strong LLM-signal skill (RAG, LangChain, LangGraph,
LangSmith, LlamaIndex, Prompt engineering, Fine-tuning, Tool calling, Agents, OpenAI API), add
"LLMs". Verified on the real CV: top match 75%→88%, "AI Engineer (LLM)" +25, all lifts sensible.

---

## 2026-06-26 13:04 — Live Daytona drop-in COMPLETE (UI + backend, verified in browser)

The full sponsor showcase works on the deployed URL: upload a screenshot → "Parsing in a Daytona
sandbox…" → the parsed job prepends to the list (green "live" badge) and the chart updates. Built
the upload control on top of the seniority-view `App.jsx` (base64 → `POST /api/extract` → prepend to
state → reactive re-derive). Verified end-to-end in the browser by the user.

**Project is feature-complete** by ~13:00 (well ahead of the 16:00 stretch window): corpus dashboard
+ seniority compare-by-level + live drop-in, all on one Vercel URL. Remaining time → rehearsal,
the 90-sec backup recording, and polish.

Also switched to **single-agent** ownership mid-afternoon after multi-agent collisions on `main`.

---

## 2026-06-26 12:37 — Daytona live drop-in backend built & proven

`dashboard/api/extract.js` now runs the **real extraction inside a Daytona sandbox** and is proven
end-to-end locally on a real screenshot (Netconomy → parsed job in ~15s).

**Key resolved open question:** the sandbox runs Python **stdlib `urllib`** to call the Anthropic API
directly — **no pip install**, so the sandbox needs nothing pre-baked and boots fast. (Confirmed the
sandbox has outbound internet.) Image base64 (~320 KB) embeds fine in the code string via
double-JSON-encoding.

**Live-job normalization:** the function applies the same map (`canonicalMap.js`, emitted by
`normalize.py`) + a parenthetical-strip + a few synonym aliases (RAG / Agents / Gen AI variants), so an
upload increments the *right* bars. Novel long-tail skills stay count-1 (hidden below the ≥2 threshold) —
acceptable; perfect normalization of an unseen job is the same unbounded problem.

**Contract:** `POST {image, media_type}` → `{job}` (jobs.json shape). Front-end builds the upload UI to this.

**REMAINING:** add **`ANTHROPIC_API_KEY` to Vercel env vars** for the *deployed* endpoint (DAYTONA_API_KEY
already set). Proven locally; deployed path untested until that key is added.

---

## 2026-06-26 12:20 — Seniority reworked: a chart "compare by level" view, not a job-list filter

**Decision:** Moved the seniority buttons from below the chart to **above it**, and changed what
they do. They're now a color-coded view selector — All (blue/global), Junior (green), Mid (amber),
Senior (red) — that **re-scopes the skills chart** to the selected level's jobs (recomputing
document frequency over just that subset) and recolors the bars to match. The job list below still
filters to the selected level too (that behavior was kept).

**Why:** The first version (a filter that only changed the job list) wasn't intuitive — the useful
question is "how do skill priorities differ by seniority," which is a *chart* comparison, not a
list filter. This makes the contrast visible: Junior → fundamentals (LLMs, Python, Vector DBs);
Senior → cloud/infra (AWS, GCP) climbs into the top.

**Threshold call:** Kept the existing required-only + freq≥2 chart filter for every level rather
than special-casing small subsets. Checked it against the real data first: at ≥2 the levels give
3 (Junior) / 16 (Mid) / 12 (Senior) bars — all non-empty and readable, so no special case needed.
Added an empty-state message as a guard for future data.

**Scope kept narrow:** stats bar stays global (corpus summary); only the chart + job list re-scope.

---

## 2026-06-26 11:56 — Seniority filter added to the job list

**Decision:** Added a Junior / Mid / Senior filter to the dashboard job list. Each button is a
toggle (click the active one, or "all", to clear). It reads `seniority` straight from the data —
no recompute — and the per-level counts shown on the buttons reflect the current skill filter.

**Scope note:** `frontend-spec.md` lists "faceted filtering by role/seniority" as *out of scope
for v0*. This was an explicit, post-v0 request, so it's a deliberate override of that cut, not
scope drift. Kept minimal and built on the existing toggle/clear/selection idiom — no redesign.

**How it composes:** skill filter narrows first, seniority narrows within that (both apply to the
shown jobs). Seniority filter only touches the job list; the skills chart is unchanged. Jobs with
a null `seniority` (allowed by the contract) simply don't match any level and drop out when a
level is selected.

---

## 2026-06-26 11:56 — Alias map extended to consolidate scattered skills

After eyeballing the real chart, extended the deterministic alias map (`normalize.py`):
- **Generative AI → LLMs** (domain call: gen AI in these AI-Engineer JDs = LLM-based).
- **Evaluation** — the model scattered it across `AI Evaluation`, `Model Evaluation`,
  `AI output evaluation`, `evaluation frameworks`, etc. → consolidated to "Evaluation"
  (now a real bar at 5 jobs, was invisible before).
- **Observability** — same scatter (`Monitoring`, `Model monitoring`, `AI observability`...)
  → "Observability" (4).
- **Fine-tuning** — `LLM fine-tuning` → "Fine-tuning".

Then, per review, also bucketed generic **APIs / Testing / Cloud / Data pipelines** (keeping
specific tools — FastAPI, A/B Testing, GCP/AWS/Azure, Airflow/Prefect/dbt — as their own bars).
APIs jumped to a top-7 bar (7). Principle held throughout: under-merge is safe, over-merge is the
error a judge catches — so only generic terms were bucketed, never distinct tools.

Note: extraction was re-run (new `data/extracted.json`, 09:11), so unrelated counts also shifted.

---

## 2026-06-25 08:02 — Demo script drafted (2-min pitch, degrades with the build)

**Artifact:** `demo-script.md` — a ~2-min live pitch with three beats (problem→question; chart +
"merged from" normalization reveal; live Daytona drop-in), plus a 20-sec elevator version, a
degraded-demo fallback, and delivery/safety tips.

**Key calls:**
- Lead the "proud moment" on the **normalization reveal** — show the tech, not polish.
- **Name-drop Daytona explicitly** in the climax (the live drop-in) for the sponsor prize.
- Structure the pitch to **degrade exactly as the build does** — drop the drop-in, then the
  click-through, then everything but chart + stats — so there's always a coherent demo.
- **End on the part-2 vision** (the shared-job-model join), not on a feature.

**Safety:** record a 90-sec backup screen capture at ~16:30 (after the freeze); have a fresh,
non-corpus screenshot ready for the live drop-in; URL open in a tab before presenting.

---

## 2026-06-25 07:58 — Make normalization visible ("merged from" reveal)

**Decision:** Added a hover tooltip on each skill bar showing **"merged from: \<raw variants\>"**
(the distinct `raw_text` values that mapped to that canonical skill), in `frontend-spec.md`.

**Why:** The front end showed the clean *output* but hid the *hard part* — extraction +
normalization. A judge seeing tidy bars might think "they just counted words." Surfacing the
raw→canonical merge turns the load-bearing technical work into something visible and rewardable.
Cheap to build (`raw_text` is already in the data); it's the front-end's "show the seams" moment,
the chart-level twin of the seniority-signal-on-hover. Hover = reveal; click stays = filter jobs.

---

## 2026-06-24 13:47 — Front-end layout locked: single-column stacked

**Decision:** The dashboard is one centered column — stats bar, skills bar chart (the hero),
job list — stacked vertically. Chosen over a two-column (chart | jobs) and a chart-hero/
click-to-reveal variant, because single-column needs the least layout fiddling, reads well on a
projector, and degrades gracefully (drop the list, the chart still stands).

**Interactions:** click a skill bar → job list filters to jobs wanting it; click a job row →
inline expand of its skills (required solid, nice-to-have outlined) + summary + seniority with
its signal on hover. Default chart view = required-only + freq ≥ 2; "show all" lifts both.

**Data contract call:** `jobs.json` is just the array of jobs (matching the extraction schema);
the frontend derives document-frequency, stats, and the skill→jobs index in memory (only ~20
jobs, so no second source of truth to keep in sync).

**Why:** Full spec in `frontend-spec.md`. Locking layout + data shape + visual style now means the
day is wiring, not designing — the place a solo builder most easily burns time.

---

## 2026-06-24 13:21 — Daytona backend round-trip is LIVE (de-risk Parts 2–3 passed)

**What worked:** The Vercel serverless function (`dashboard/api/extract.js`) is deployed and
live at `/api/extract`, returning `{"output":"hi from daytona\n","exitCode":0}`. This confirms,
on the real platform:
- Vercel **auto-detects `dashboard/api/`** for the Vite project — no `vercel.json` needed.
- `DAYTONA_API_KEY` is wired via **Vercel env vars** (Settings → Environment Variables).
- The function creates a Daytona sandbox, runs Python, and returns JSON.

**So:** the whole backend round-trip for the live drop-in is proven (browser → Vercel function →
Daytona sandbox → output). The sponsor showcase is no longer a risky unknown.

**Day-of work for the showcase** is now just: swap the trivial script for the real extraction
(vision call + schema) running in the sandbox, and accept an uploaded image in the request. The
two still-open questions (how the extraction deps get into the sandbox, how the model key reaches
code inside it) get answered when wiring that real extraction.

---

## 2026-06-24 11:55 — Daytona round-trip verified (de-risk Part 1 passed)

**What worked:** The Daytona hello-world round-trip runs green with a real key
(`scratch/daytona_hello.mjs`). Confirmed SDK shape for the build: package `@daytona/sdk`,
`new Daytona({ apiKey })`, `daytona.create({ language: 'python' })`,
`sandbox.process.codeRun('<code>')` → `response.result` (stdout) / `response.exitCode`,
`sandbox.delete()`. Create → run Python → read output → delete all work as drafted.

**So:** the riskiest piece of the sponsor showcase (Daytona wiring) is de-risked. Remaining
de-risk steps are Vercel-function plumbing (Parts 2–4), not Daytona itself.

**Still open (for Part 2+):** how the real extraction code + its Python deps get into the
sandbox, and how the model API key reaches code running inside the sandbox.

---

## 2026-06-24 10:35 — Committed to the Daytona live drop-in as the gated sponsor stretch

**Decision:** Pursue the live "drop in a screenshot → parse it in a Daytona sandbox" feature as
the Phase 4 stretch and the sponsor-prize play. Architecture: a **Vercel serverless function**
(`dashboard/api/extract.*`, same repo, no separate host) calls the Daytona SDK to run the Python
extraction in a sandbox; React updates statelessly (no database).

**Trade-off:** This deviates from the "no backend" rule — but only for this one feature, and it's
**gated behind the deployed static dashboard**, so the prize floor (live URL) is never at risk.

**Hard condition:** de-risk the round-trip during the week (`daytona-prep-checklist.md`) — prove a
hello-world Browser → Vercel function → Daytona sandbox → output round-trip. If that isn't working
by the end of prep, drop the showcase. Lighter fallback: run the offline batch extraction through a
sandbox for a weaker-but-genuine sponsor story.

**Why feasible solo:** the "backend" is just a Vercel function in the same repo (not a second host),
it's stateless (no DB), and the scary part (Daytona wiring) gets proven *before* the day, leaving
only a script-swap for the day itself.

---

## 2026-06-24 10:22 — Enrollment requirements pinned; MIT license added

**Context:** The event is open-format (no rules on when code is written, so all our prep is
fine). The only hard gates: a live URL at end of day, the repo open source, and the project
built at the event (can't bring a pre-built one).

**Decisions:**
- Added an **MIT license** so the public repo is formally open source (a named enrollment
  requirement). MIT chosen as the permissive hackathon default.
- Pinned the gates as a "Submission Requirements" checklist in the plan. The live-URL gate —
  the only thing required for *any* prize — is already solved cold via the deploy prep.
- **Sponsor is Daytona.** Using the sponsor stack is a *winning* edge, not a qualifying gate.
  How (and whether) to integrate it is evaluated separately — it trades against the
  no-backend architecture, so it's a real call, not a freebie.

---

## 2026-06-24 10:04 — Normalization contingency plan + primary fallback

**Decision:** Added a "Normalization — contingency plan" section to the sprint plan: the
likely failure modes (case dups, slash-lists, non-obvious synonyms, over-merging, one-vs-two
calls) and the move for each, plus an escalation ladder if the chart still looks like noise.

**Key calls:**
- **Primary fallback = a curated allowlist** of ~15–25 hand-picked canonical skills; chart
  only those, everything else stays in data/click-through. Reach for it early, not last —
  it turns open-ended reconciliation into a closed-set lookup.
- **No live LLM normalization** in the pipeline (reinforces the 09:26 entry). At most, use an
  LLM once to *propose* a map, then freeze it into code.
- **Hard time box at 14:15:** freeze whatever's "sane enough" and go build the chart; the
  15:00 deployed-chart milestone wins over a perfect map.

---

## 2026-06-24 10:00 — Keep DECISIONS.md; log silently and proactively

**Decision:** Reversed an earlier sprint call. `AGENTS.md` originally listed DECISIONS.md
as deliberately dropped for this sprint; we now keep a lightweight version. Added a
"Decision log" section to `AGENTS.md` defining when to add entries.

**The rule:** over-share rather than under-share (when in doubt, log it), but do it
**silently** — write the entry, fold it into the same commit as the change, and do **not**
narrate "I added to DECISIONS, here's why" in chat. Reading that mid-event wastes time;
the log is read when the person chooses, not in the reply.

**Why:** During the timed event there's no room to discuss record-keeping. Making it an
automatic, invisible habit means the context gets captured without costing live minutes.

---

## 2026-06-24 09:52 — Sprint day runs on a clock, planned backwards from the 5pm demo

**Decision:** Added a timed schedule to the sprint plan (see "Timeline (Day Of)"). Fixed
points are hack-start 11:00, lunch 12:00–13:00, demo 17:00 — so 5 hours of build time.
The schedule is built **backwards from the demo**, not forwards from the start.

**Key calls:**
- **Hard stop at 16:30** (30 min before demo): stop building entirely, redeploy from a
  clean `main`, and test the live URL in a fresh incognito window as a stranger would.
  Reasoning: a dead demo from a last-minute deploy is the worst-case outcome for a solo
  builder, and 30 minutes is cheap insurance against it.
- **Protect the 15:00 milestone:** a deployed ranked chart + sane skill counts. If behind
  at any point, cut panels upward from the bottom (3d → 3c → 3b), never the chart or the
  normalization under it.

**Trade-off:** The clock is deliberately conservative (a real 30-min freeze, a real lunch).
Better to ship fewer panels calmly than to be mid-edit when judging starts.

---

## 2026-06-24 09:26 — Skill normalization must be done in code after extraction, not by the prompt

**Decision:** Collapsing different spellings of the same skill into one name (e.g.
"Vector databases" and "Vector Databases" → one entry) will be done by a deterministic
**post-processing step in code**, run once over all the extracted skills together —
**not** by asking the LLM to do it in the extraction prompt.

**What we tried that failed:** We added a rule to the extraction prompt telling the
model to normalize case. We re-ran the probe. It did nothing — the same skill still
came out as two separate bars. (That prompt line has since been removed.)

**Why it can't work in the prompt:** Each screenshot is sent to the model on its own,
so the model never sees the other jobs. It has no way to be consistent across the whole
batch. Consistency across all jobs can only come from one piece of code that looks at
everything at once.

**Also found (same root cause):** When a job listed tools as a slash-list, the model
kept only the first and silently dropped the rest — "n8n/Make/Zapier" became just
"n8n", and "GCP/AWS/Azure" became just "GCP". It did this inconsistently between runs.
So the code step also needs to split slash-lists into separate skills before mapping.

**Status:** Plan updated (see "The Load-Bearing Risk" in `jd-aggregator-sprint-plan.md`).
The code step itself is **not built yet** — it's a sprint-day task. The model still
returns a `canonical` guess; treat it as a hint, not the truth.

---

## 2026-06-23 14:31 — Chart shows the signal, dataset keeps everything

**Decision:** The skills chart defaults to showing only skills that (a) appear in **2 or
more** jobs and (b) are marked **required** (not nice-to-have). One-off skills and
nice-to-haves are still extracted and stored — they just don't clutter the default
chart, and stay reachable by clicking into a job.

**Why:** Running the probe on real screenshots produced a long tail of skills that only
showed up once. On a bar chart that's noise and buries the real market signal.

**Trade-off:** These thresholds are **view filters only** — we never drop data during
extraction. A "show all" toggle can lift them. Nothing is lost; it's just hidden by
default.

**What this required:** A new per-skill field, `requirement` (required vs nice_to_have).
We confirmed the model does assign both labels (26 required / 19 nice-to-have across 3
jobs). We have **not** yet checked whether those labels are actually correct against the
job text — that's still worth eyeballing.

---

## 2026-06-23 11:27 — De-risk extraction in a notebook, before the sprint

**Decision:** Built `scratch/extraction_probe.ipynb` to test the extraction approach on
a few real screenshots during the week, so sprint day is execution, not discovery.

**Key calls:**
- **Provider-agnostic:** one flag switches between OpenAI and Anthropic, because we
  don't yet know which one the hackathon will give credits for.
- **Structured output via a Pydantic schema** (raw SDK call, no LangChain) — simpler and
  easier to inspect.
- **Screenshots are git-ignored** — kept on the laptop, off GitHub.
- Added `ipykernel` so the notebook runs in the project's `.venv`.

**Verified (actually ran it):** Both providers work end-to-end — Anthropic accepts the
Pydantic schema as a tool input, and OpenAI's `chat.completions.parse` works on the
installed version. (A `beta` fallback in the code is dead on this version but harmless.)

---

## 2026-06-23 11:16 — Test both API keys ahead of time

**Decision:** Wrote `test_key.py`, which makes one tiny call to **both** OpenAI and
Anthropic and reports each separately. Both passed.

**Why:** The hackathon supplies credits but we don't know the provider. Confirming both
keys work now means no surprise on the day. Used the cheapest models (gpt-4o-mini,
claude-haiku) so the test costs ~nothing. The key lives in a git-ignored `.env` and is
never committed.

---

## 2026-06-23 10:27–11:12 — Deploy path fixed and proven

**What went wrong:** The first Vercel setup quietly created a **separate** GitHub repo
(`job-pipeline-dashboard`) from a template and deployed *that*, instead of our real repo
(`job-pipeline`). So our `git push`es went to one repo while Vercel watched another —
the live site stayed frozen on an unrelated "Initial commit" no matter what we pushed.

**Fix:** Deleted that Vercel project and the stray repo, then re-imported the **real**
`job-pipeline` repo with **Root Directory = `dashboard`**. After that, we changed a line,
pushed, and watched the live site update on its own — the deploy loop is proven.

**Lessons for future-you / future agents:**
- When importing to Vercel, import the **existing** repo. Don't accept a new
  template-generated repo.
- The React app lives in `dashboard/`; Vercel's Root Directory must be set to it.
- To check whether a deploy worked, look at the **JS bundle** or the browser — a plain
  `curl` of `/` only returns an empty HTML shell for a Vite/React app, so it always
  looks "empty" even when the deploy is fine.
- Live URL: `https://job-pipeline-opal.vercel.app`

---

## Earlier — Architecture decisions (pre-dates this log)

The big structural calls — why there's **no backend**, why extraction runs once on the
laptop and writes a static `jobs.json`, why **Vite + React** and **Vercel**, and the
shared `job` / `skill` data model that lets part 2 (the email parser) plug in later —
are written up in `jd-aggregator-sprint-plan.md` under "Tech Stack & Architecture" and
"Shared Data Model". Read those there rather than duplicating here.
