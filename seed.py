"""One-off seed: load the normalized corpus (dashboard/public/jobs.json) into Supabase.

Run ONCE:  uv run seed.py
Re-running against a populated DB errors on duplicate job.id — this script guards against
that (aborts if the job table is non-empty). To reseed, truncate the tables first.
"""

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

# Guard: never double-seed.
if client.table("job").select("id").limit(1).execute().data:
    raise SystemExit("job table is not empty — aborting so we don't duplicate the seed. "
                     "Truncate job/skill first if you really want to reseed.")

data = json.loads(Path("dashboard/public/jobs.json").read_text())
jobs = data["jobs"]

job_rows, skill_rows = [], []
for j in jobs:
    job_rows.append({
        "id": j["id"],
        "company": j["company"],
        "title": j["title"],
        "seniority": j["seniority"],
        "seniority_signal": j["seniority_signal"],
        "seniority_basis": j["seniority_basis"],
        "summary": j["summary"],
        "source": "corpus",              # seed rows are 'corpus'; live drop-ins are 'screenshot'
        "non_skill_mentions": j.get("non_skill_mentions", []),
    })
    for s in j["skills"]:
        skill_rows.append({
            "job_id": j["id"],
            "raw_text": s["raw_text"],
            "canonical": s["canonical"],
            "requirement": s["requirement"],
            "alternative_group": s.get("alternative_group"),
        })

client.table("job").insert(job_rows).execute()      # jobs first (skill.job_id FK)
client.table("skill").insert(skill_rows).execute()

print(f"seeded {len(job_rows)} jobs, {len(skill_rows)} skills")
