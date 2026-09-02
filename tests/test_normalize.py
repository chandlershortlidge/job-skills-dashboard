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


class TestExtractedSkillLabel:
    def test_reads_new_model_field(self):
        assert normalize.extracted_skill_label({"extracted_skill": "Python"}) == "Python"

    def test_reads_legacy_canonical_field(self):
        assert normalize.extracted_skill_label({"canonical": "Python"}) == "Python"

    def test_prefers_new_field_during_migration(self):
        assert normalize.extracted_skill_label({
            "extracted_skill": "New label",
            "canonical": "Legacy label",
        }) == "New label"

    def test_rejects_a_skill_without_either_identity_field(self):
        try:
            normalize.extracted_skill_label({"raw_text": "Python"})
        except KeyError as error:
            assert "extracted_skill or legacy canonical" in str(error)
        else:
            raise AssertionError("missing model identity field should fail")


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

    def test_merges_microsoft_azure_into_the_cloud_platform_canonical(self):
        assert normalize.resolve("Microsoft Azure", {}) == "Azure"

    def test_merges_the_mcp_full_name_into_the_acronym_canonical(self):
        assert normalize.resolve("Model Context Protocol", {}) == "MCP"

    def test_keeps_multi_agent_systems_as_its_own_canonical(self):
        assert normalize.resolve("multi-agent systems", {}) == "Multi-Agent Systems"

    def test_merges_etl_elt_pipelines_into_data_pipelines(self):
        assert normalize.resolve("ETL/ELT Pipelines", {}) == "Data pipelines"

    def test_merges_short_etl_elt_into_data_pipelines(self):
        assert normalize.resolve("ETL/ELT", {}) == "Data pipelines"

    def test_keeps_broad_ai_ml_distinct_from_explicit_machine_learning(self):
        assert normalize.resolve("AI/ML", {}) == "AI/ML"
        assert normalize.resolve("AI/ML ecosystem", {}) == "AI/ML"
        assert normalize.resolve("Applied AI", {}) == "AI/ML"
        assert normalize.resolve("Machine Learning", {}) == "Machine Learning"

    def test_stabilizes_golden_016_framework_and_platform_names(self):
        assert normalize.resolve("Google Agent Development Kit", {}) == "Google ADK"
        assert normalize.resolve("Google Agent Development Kit (ADK)", {}) == "Google ADK"
        assert normalize.resolve("Gemini Models", {}) == "Gemini"
        assert normalize.resolve("RAGAs", {}) == "Ragas"
        assert normalize.resolve("Vertex AI", {}) == "Vertex AI"
        assert normalize.resolve("Vector Search", {}) == "Vector Search"
        assert normalize.resolve("AIOps", {}) == "AIOps"

    def test_does_not_collapse_google_cloud_ai_ml_into_a_duplicate_parent(self):
        assert normalize.resolve("Google Cloud AI/ML", {}) == "Google Cloud AI/ML"

    def test_stabilizes_golden_017_lifecycle_and_parent_labels(self):
        assert normalize.resolve("Model Deployment", {}) == "AI deployment"
        assert normalize.resolve("ML Model Deployment", {}) == "AI deployment"
        assert normalize.resolve("Deep Learning Frameworks", {}) == "Deep Learning"
        assert normalize.resolve("containerized workloads", {}) == "Containerization"

    def test_stabilizes_golden_018_s3_provider_spelling(self):
        assert normalize.resolve("Amazon S3", {}) == "AWS S3"

    def test_reconciles_llm_integration_and_coding_tool_categories(self):
        assert normalize.resolve("LLM Integration", {}) == "AI Integration"
        assert normalize.resolve("AI Integration", {}) == "AI Integration"
        assert normalize.resolve("coding agents", {}) == "AI developer tooling"

    def test_stabilizes_named_coding_products_and_golden_013_bare_copilot(self):
        assert normalize.resolve("Codex", {}) == "Codex"
        assert normalize.resolve("OpenAI Codex", {}) == "Codex"
        assert normalize.resolve("GitHub Copilot", {}) == "GitHub Copilot"
        assert normalize.resolve("Copilot", {}) == "GitHub Copilot"

    def test_merges_ai_security_guardrails_into_existing_canonical(self):
        assert normalize.resolve("AI Security Guardrails", {}) == "security guardrails"

    def test_keeps_api_design_distinct_from_api_use(self):
        assert normalize.resolve("API design", {}) == "API Design"
        assert normalize.resolve("API architecture", {}) == "API Design"
        assert normalize.resolve("API integration", {}) == "APIs"


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

    def test_exact_case_react_pattern_stays_distinct_from_react_framework(self):
        display = {"react": "React"}
        assert normalize.resolve("ReAct", display) == "ReAct"
        assert normalize.resolve("React", display) == "React"

    def test_llm_orchestration_stays_distinct_from_llms(self):
        display = {"llm orchestration": "LLM orchestration", "llms": "LLMs"}
        assert normalize.resolve("LLM orchestration", display) == "LLM orchestration"
        assert normalize.resolve("LLMs", display) == "LLMs"

    def test_pandas_alias_pins_library_casing(self):
        assert normalize.resolve("pandas", {}) == "pandas"
        assert normalize.resolve("Pandas", {}) == "pandas"

    def test_live_map_carries_exact_case_aliases(self):
        canon_map = normalize.build_canon_map({"react": "React"})
        assert canon_map["exact_map"] == {"ReAct": "ReAct"}

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

    def test_new_extracted_skill_input_reproduces_legacy_normalized_output(self):
        legacy_jobs = self._extracted()["jobs"]
        migrated_jobs = json.loads(json.dumps(legacy_jobs))
        for job in migrated_jobs:
            for skill in job["skills"]:
                skill["extracted_skill"] = skill.pop("canonical")

        legacy_display = normalize.build_display(legacy_jobs)
        migrated_display = normalize.build_display(migrated_jobs)
        assert migrated_display == legacy_display
        assert normalize.normalize_jobs(migrated_jobs, migrated_display) == (
            normalize.normalize_jobs(legacy_jobs, legacy_display)
        )
