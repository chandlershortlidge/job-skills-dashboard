"""Tests for the deterministic normalization primitives in normalize.py.

Covers only the pure, top-level pieces: split_skill() and the SPLITS / ALIASES
tables. The resolution / per-job dedup / clean_variants logic still lives inside
normalize.main() (mixed with file I/O), so it is deferred until that is refactored
into pure functions — see AGENTS.md's layout rules.
"""

import json
from pathlib import Path

import normalize

FIXTURES = Path(__file__).parent / "fixtures"


class TestSplitSkill:
    def test_splits_a_known_slash_list(self):
        assert normalize.split_skill("GCP/AWS/Azure") == ["GCP", "AWS", "Azure"]

    def test_split_key_lookup_is_case_insensitive(self):
        assert normalize.split_skill("gcp/aws/azure") == ["GCP", "AWS", "Azure"]

    def test_protected_slash_terms_do_not_split(self):
        # CI/CD, A/B Testing, ETL/ELT are single skills — they must stay intact.
        assert normalize.split_skill("CI/CD") == ["CI/CD"]
        assert normalize.split_skill("A/B Testing") == ["A/B Testing"]

    def test_non_split_skill_is_stripped(self):
        assert normalize.split_skill("  Python  ") == ["Python"]

    def test_unknown_skill_returned_as_single_item(self):
        assert normalize.split_skill("Kubernetes") == ["Kubernetes"]


class TestAliasAndSplitTables:
    def test_alias_keys_are_lowercased(self):
        # resolve() looks aliases up by lowercased key, so a non-lowercased key would
        # silently never match — guard against that dead-entry bug.
        for key in normalize.ALIASES:
            assert key == key.lower(), f"alias key not lowercased: {key!r}"

    def test_alias_values_are_nonempty(self):
        for key, value in normalize.ALIASES.items():
            assert value and value.strip(), f"empty canonical for alias {key!r}"

    def test_split_keys_lowercased_and_values_nonempty(self):
        for key, parts in normalize.SPLITS.items():
            assert key == key.lower(), f"split key not lowercased: {key!r}"
            assert parts and all(p.strip() for p in parts), f"bad split value for {key!r}"


class TestResolve:
    def test_alias_takes_priority_over_display(self):
        display = {"large language models": "Large Language Models"}
        assert normalize.resolve("Large Language Models", display) == "LLMs"

    def test_uses_display_spelling_when_no_alias(self):
        assert normalize.resolve("python", {"python": "Python"}) == "Python"

    def test_unknown_part_passes_through_stripped(self):
        assert normalize.resolve("  Kubernetes  ", {}) == "Kubernetes"

    def test_lookup_is_case_insensitive(self):
        assert normalize.resolve("FASTAPI", {"fastapi": "FastAPI"}) == "FastAPI"


class TestCleanVariants:
    def test_drops_phrases_over_40_chars(self):
        long = "a" * 41
        assert long not in normalize.clean_variants("X", {long, "short one"})

    def test_drops_the_canonical_itself(self):
        assert normalize.clean_variants("RAG", {"RAG", "rag pipelines"}) == ["rag pipelines"]

    def test_dedupes_case_insensitively(self):
        # three spellings of one word collapse to one (which spelling wins is an impl detail)
        assert len(normalize.clean_variants("X", {"React", "react", "REACT"})) == 1

    def test_caps_at_six(self):
        raws = {f"variant number {i}" for i in range(10)}
        assert len(normalize.clean_variants("X", raws)) <= 6


class TestNormalizeJobs:
    def _sample_jobs(self):
        return json.loads((FIXTURES / "sample_extracted.json").read_text())["jobs"]

    def test_one_output_job_per_input_job_with_expected_keys(self):
        jobs = self._sample_jobs()
        out, _ = normalize.normalize_jobs(jobs, normalize.build_display(jobs))
        assert len(out) == len(jobs)
        for oj in out:
            assert set(oj) == {
                "id", "company", "title", "seniority", "seniority_signal",
                "seniority_basis", "summary", "source", "non_skill_mentions", "skills",
            }

    def test_skill_identities_are_distinct_within_a_job(self):
        jobs = self._sample_jobs()
        out, _ = normalize.normalize_jobs(jobs, normalize.build_display(jobs))
        for oj in out:
            identities = [(s["canonical"], s["alternative_group"]) for s in oj["skills"]]
            assert len(identities) == len(set(identities)), f"duplicate identity in {oj['id']}"

    def test_required_wins_over_nice_to_have(self):
        jobs = [{
            "id": "j", "company": "C", "title": "T", "seniority": "Mid",
            "seniority_signal": None, "seniority_basis": "inferred", "summary": "s",
            "skills": [
                {"canonical": "Python", "raw_text": "Python", "requirement": "nice_to_have"},
                {"canonical": "Python", "raw_text": "Python", "requirement": "required"},
            ],
        }]
        out, _ = normalize.normalize_jobs(jobs, normalize.build_display(jobs))
        py = next(s for s in out[0]["skills"] if s["canonical"] == "Python")
        assert py["requirement"] == "required"

    def test_preserves_non_skill_audit_and_alternative_groups(self):
        jobs = [{
            "id": "j", "company": "C", "title": "T", "seniority": "Mid",
            "seniority_signal": None, "seniority_basis": "inferred", "summary": "s",
            "skills": [
                {"canonical": "Python", "raw_text": "Python or Java", "requirement": "required", "alternative_group": "alt-1"},
                {"canonical": "Java", "raw_text": "Python or Java", "requirement": "required", "alternative_group": "alt-1"},
            ],
            "non_skill_mentions": [{"raw_text": "Degree in CS", "category": "education", "requirement": "required"}],
        }]
        out, _ = normalize.normalize_jobs(jobs, normalize.build_display(jobs))
        assert out[0]["skills"] == [
            {"canonical": "Python", "raw_text": "Python or Java", "requirement": "required", "alternative_group": "alt-1"},
            {"canonical": "Java", "raw_text": "Python or Java", "requirement": "required", "alternative_group": "alt-1"},
        ]
        assert out[0]["non_skill_mentions"] == jobs[0]["non_skill_mentions"]


class TestGolden:
    """Characterization: the refactored pure functions must reproduce, byte-for-byte,
    the outputs the pre-refactor code produced from the real corpus."""

    def _extracted(self):
        return json.loads(Path("data/extracted.json").read_text())

    def test_reproduces_golden_jobs_json(self):
        data = self._extracted()
        jobs = data["jobs"]
        out_jobs, skill_variants = normalize.normalize_jobs(jobs, normalize.build_display(jobs))
        produced = json.dumps(
            {"generated_at": data.get("generated_at"), "jobs": out_jobs, "skill_variants": skill_variants},
            indent=2, ensure_ascii=False,
        )
        assert produced == (FIXTURES / "golden_jobs.json").read_text()

    def test_reproduces_golden_canonical_map_js(self):
        display = normalize.build_display(self._extracted()["jobs"])
        payload = normalize.build_canon_map(display)
        produced = (
            "// generated by normalize.py — do not edit by hand\nexport default "
            + json.dumps(payload, indent=2, ensure_ascii=False)
            + "\n"
        )
        assert produced == (FIXTURES / "golden_canonicalMap.js").read_text()
