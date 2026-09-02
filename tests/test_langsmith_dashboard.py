"""Lock the read-only LangSmith dashboard boundary and comparison policy.

Tests use the retained real SDK snapshot plus derived edge variants. They do NOT
call LangSmith, Streamlit, an LLM, Daytona, Supabase, or Storage.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from streamlit.testing.v1 import AppTest

from langsmith_dashboard import (
    ALTERNATIVE_METRIC,
    CORE_METRICS,
    MAX_PROJECTS,
    RUN_SELECTS,
    aggregate_metrics,
    applicable_metrics,
    classify_row,
    compare_experiments,
    experiment_integrity,
    list_jd_experiments,
    load_experiment,
    metric_role,
    normalized_metric,
)
from langsmith_dashboard_view import (
    aggregate_metric_rows,
    comparison_message,
    experiment_health,
    fixture_metric_rows,
    fixture_outcome_counts,
    format_count,
    format_score,
    metric_label,
    trend_rows,
)


SNAPSHOT = json.loads(
    Path("tests/fixtures/langsmith_experiment_snapshot.json").read_text()
)


def captured_experiment(project_id: str) -> dict:
    return {
        "project": copy.deepcopy(
            next(project for project in SNAPSHOT["projects"] if project["id"] == project_id)
        ),
        "runs": copy.deepcopy(
            [run for run in SNAPSHOT["runs"] if run["project_id"] == project_id]
        ),
        "feedback": copy.deepcopy(
            [
                item
                for item in SNAPSHOT["feedback"]
                if any(
                    run["id"] == item["run_id"]
                    for run in SNAPSHOT["runs"]
                    if run["project_id"] == project_id
                )
            ]
        ),
        "historical_examples": copy.deepcopy(SNAPSHOT["historical_examples"]),
        "historical_example_errors": [],
    }


def render_fixture_detail(title, run, experiment):
    from streamlit_app import render_run_detail

    render_run_detail(title, run, experiment)


def render_overview_fixture(inventory, comparison, baseline, candidate):
    from streamlit_app import render_overview

    render_overview(inventory, comparison, baseline, candidate)


def render_engineering_fixture(comparison, baseline, candidate):
    from streamlit_app import render_engineering

    render_engineering(comparison, baseline, candidate)


def one_fixture_pair() -> tuple[dict, dict]:
    baseline = captured_experiment("project-1")
    candidate = captured_experiment("project-2")
    for experiment in (baseline, candidate):
        experiment["runs"] = [
            run for run in experiment["runs"] if run["reference_example_id"] == "example-1"
        ]
        run_ids = {run["id"] for run in experiment["runs"]}
        experiment["feedback"] = [
            item for item in experiment["feedback"] if item["run_id"] in run_ids
        ]
        experiment["project"]["extra"]["metadata"]["fixture_count"] = 1
    return baseline, candidate


def test_retained_fixture_proves_metric_roles_and_historical_applicability():
    baseline = captured_experiment("project-1")
    golden_003 = next(run for run in baseline["runs"] if run["reference_example_id"] == "example-1")
    golden_001 = next(run for run in baseline["runs"] if run["reference_example_id"] == "example-2")

    assert len(applicable_metrics(golden_003, baseline)) == 15
    assert len(applicable_metrics(golden_001, baseline)) == 18
    assert ALTERNATIVE_METRIC not in applicable_metrics(golden_003, baseline)
    assert ALTERNATIVE_METRIC in applicable_metrics(golden_001, baseline)
    assert metric_role("responsibility_support") == "context"
    assert metric_role("skill_canonical_precision") == "quality"
    assert metric_role("future_metric") == "unknown"
    assert normalized_metric("technical_canonical_recall") == "skill_canonical_recall"


def test_real_partial_snapshot_refuses_deltas_and_preserves_error_status():
    comparison = compare_experiments(
        captured_experiment("project-1"), captured_experiment("project-2")
    )

    assert comparison["compatible"] is False
    assert any("observed 2 roots, declared 20" in reason for reason in comparison["incompatibility_reasons"])
    assert {row["label"]: row["status"] for row in comparison["rows"]} == {
        "golden_001": "error",
        "golden_003": "not comparable",
    }
    assert all(row["delta"] is None for row in comparison["aggregate_rows"])


def test_aggregate_coverage_uses_historical_applicability_not_support_feedback():
    result = aggregate_metrics(captured_experiment("project-1"))

    assert result["unknown_reference_ids"] == []
    assert result["metrics"]["skill_canonical_precision"] == pytest.approx(
        {
            "mean": 0.75,
            "returned": 2,
            "applicable": 2,
            "contributor_ids": ["example-1", "example-2"],
            "applicability_known": True,
            "unknown_applicability": 0,
        }
    )
    assert not any(key.endswith("_support") for key in result["metrics"])


@pytest.mark.parametrize(
    ("left", "right", "compatible", "expected"),
    [
        ({"a": 0.2}, {"a": 0.3}, True, "improved"),
        ({"a": 0.3}, {"a": 0.2}, True, "regressed"),
        ({"a": 0.2}, {"a": 0.2 + 1e-10}, True, "unchanged"),
        ({"a": 0.2, "b": 0.4}, {"a": 0.3, "b": 0.3}, True, "mixed"),
        ({"a": 0.2}, {"a": 0.3}, False, "not comparable"),
    ],
)
def test_status_matrix_for_complete_runs(left, right, compatible, expected):
    run = {"status": "success"}
    status, _ = classify_row(
        run, run, set(left), set(right), left, right, compatible
    )
    assert status == expected


def test_status_matrix_for_missing_metrics_runs_and_errors():
    success = {"status": "success"}
    error = {"status": "error"}

    assert classify_row(error, success, set(), set(), {}, {}, True)[0] == "error"
    assert classify_row(None, success, None, {"a"}, {}, {"a": 1}, True)[0] == "unavailable"
    assert classify_row(success, success, {"a"}, {"b"}, {"a": 1}, {"b": 1}, True)[0] == "unavailable"
    assert classify_row(success, success, {"a"}, {"a"}, {}, {"a": 1}, True)[0] == "unavailable"


def test_integrity_rejects_duplicate_null_and_overflow_reference_runs():
    baseline, _ = one_fixture_pair()
    original = baseline["runs"][0]

    duplicate = copy.deepcopy(original)
    duplicate["id"] = "duplicate-run"
    baseline["runs"].append(duplicate)
    baseline["project"]["extra"]["metadata"]["fixture_count"] = 2
    assert any("duplicate reference_example_id" in reason for reason in experiment_integrity(baseline))

    baseline["runs"][1]["reference_example_id"] = None
    assert any("no reference_example_id" in reason for reason in experiment_integrity(baseline))

    baseline["project"]["extra"]["metadata"]["fixture_count"] = 1
    assert any("observed 2 roots, declared 1" in reason for reason in experiment_integrity(baseline))

    baseline["runs"] = [original]
    baseline["runs"][0]["status"] = "pending"
    assert any("contains an incomplete run" in reason for reason in experiment_integrity(baseline))


def test_comparison_requires_identical_full_reference_sets():
    baseline, candidate = one_fixture_pair()
    candidate["runs"][0]["reference_example_id"] = "different-example"

    result = compare_experiments(baseline, candidate)
    assert result["compatible"] is False
    assert "full reference_example_id sets differ" in result["incompatibility_reasons"]


class ProjectClient:
    def __init__(self, projects):
        self.projects = projects
        self.project_kwargs = None
        self._host_url = "https://smith.langchain.test"

    def read_dataset(self, *, dataset_name):
        assert dataset_name == "jd-skill-extraction-golden-v1"
        return SimpleNamespace(id="dataset-1", name=dataset_name)

    def list_projects(self, **kwargs):
        self.project_kwargs = kwargs
        return iter(self.projects)


def project_record(**overrides):
    values = {
        "id": "project-id",
        "name": "jd-skill-extraction-baseline-test",
        "reference_dataset_id": "dataset-1",
        "tenant_id": "tenant-id",
        "start_time": datetime.fromisoformat("2026-08-21T00:00:00+00:00"),
        "end_time": datetime.fromisoformat("2026-08-21T00:01:00+00:00"),
        "run_count": 20,
        "error_rate": 0,
        "extra": {"metadata": {"fixture_count": 20, "fixture_manifest_sha256": "manifest"}},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_project_listing_is_dataset_scoped_prefix_checked_and_bounded():
    client = ProjectClient(
        [project_record(), project_record(id="adjacent", name="other-jd-skill-extraction-baseline")]
    )
    result = list_jd_experiments(client)

    assert [project["id"] for project in result["projects"]] == ["project-id"]
    assert client.project_kwargs == {
        "reference_dataset_id": "dataset-1",
        "name_contains": "jd-skill-extraction-baseline",
        "include_stats": True,
        "limit": MAX_PROJECTS,
    }


def test_project_listing_rejects_a_same_prefix_project_from_another_dataset():
    client = ProjectClient([project_record(reference_dataset_id="wrong-dataset")])
    with pytest.raises(ValueError, match="expected reference dataset dataset-1"):
        list_jd_experiments(client)


class AsyncRows:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        self.iterator = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self.iterator)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class RunsResource:
    def __init__(self, rows):
        self.rows = rows
        self.kwargs = None

    async def query(self, **kwargs):
        self.kwargs = kwargs
        return AsyncRows(self.rows)


class ExperimentClient:
    def __init__(self, runs, feedback, examples):
        self.runs = RunsResource(runs)
        self.feedback = feedback
        self.examples = examples
        self.example_calls = []

    def list_feedback(self, *, run_ids):
        assert set(run_ids) == {run.id for run in self.runs.rows}
        return iter(self.feedback)

    def read_example(self, example_id, *, as_of):
        self.example_calls.append((example_id, as_of))
        return self.examples[(example_id, as_of.isoformat().replace("+00:00", "Z"))]


def test_live_loader_uses_bounded_async_query_and_historical_versions():
    project = copy.deepcopy(SNAPSHOT["projects"][0])
    project["extra"]["metadata"]["fixture_count"] = 1
    run_data = next(run for run in SNAPSHOT["runs"] if run["project_id"] == project["id"])
    run = SimpleNamespace(
        **{key: value for key, value in run_data.items() if key not in {"extra", "url"}},
        metadata=run_data["extra"]["metadata"],
        trace_id=run_data["id"],
    )
    feedback = [
        SimpleNamespace(**item)
        for item in SNAPSHOT["feedback"]
        if item["run_id"] == run.id
    ]
    matching_example = next(
        example
        for example in SNAPSHOT["historical_examples"]
        if example["id"] == run.reference_example_id
        and example["as_of"] == run.metadata["example_version"]
    )
    example_object = SimpleNamespace(
        id=matching_example["id"],
        inputs=matching_example["inputs"],
        outputs=matching_example["outputs"],
    )
    client = ExperimentClient(
        [run],
        feedback,
        {(matching_example["id"], matching_example["as_of"]): example_object},
    )

    result = load_experiment(client, project)

    assert len(result["runs"]) == 1
    assert client.runs.kwargs["page_size"] == 2
    assert client.runs.kwargs["is_root"] is True
    assert client.runs.kwargs["selects"] == RUN_SELECTS
    assert isinstance(client.runs.kwargs["min_start_time"], datetime)
    assert client.example_calls[0][1].isoformat().endswith("+00:00")


def test_streamlit_run_detail_renders_from_fixture_without_network():
    baseline = captured_experiment("project-1")
    run = baseline["runs"][0]

    app = AppTest.from_function(
        render_fixture_detail,
        args=("Baseline", run, baseline),
    ).run()

    assert not app.exception
    assert any(item.value == "#### Baseline" for item in app.markdown)
    assert any(item.label == "Historical expected output" for item in app.status)


def test_streamlit_overview_and_debugger_render_from_fixture_without_network():
    baseline = captured_experiment("project-1")
    candidate = captured_experiment("project-2")
    comparison = compare_experiments(baseline, candidate)
    inventory = {
        "dataset": {"name": "jd-skill-extraction-golden-v1"},
        "projects": [baseline["project"], candidate["project"]],
    }

    overview = AppTest.from_function(
        render_overview_fixture,
        args=(inventory, comparison, baseline, candidate),
    ).run()
    debugger = AppTest.from_function(
        render_engineering_fixture,
        args=(comparison, baseline, candidate),
    ).run()

    assert not overview.exception
    assert any(item.value == "Did the candidate make the system better?" for item in overview.header)
    assert any("Not fully comparable" in item.value for item in overview.warning)
    assert any(item.value == "Raw scores — comparison disabled" for item in overview.subheader)
    assert all(str(item.label).startswith("Candidate · ") for item in overview.metric)
    assert all(not str(item.value).startswith("Candidate ") for item in overview.metric)
    assert all(not item.delta for item in overview.metric)
    assert sum(item.value.startswith("Baseline ") for item in overview.caption) >= 4
    assert not debugger.exception
    assert any(item.value == "Eval Debugger" for item in debugger.header)


def test_streamlit_valid_overview_labels_kpis_and_shows_guarded_delta():
    baseline, candidate = one_fixture_pair()
    comparison = compare_experiments(baseline, candidate)
    inventory = {
        "dataset": {"name": "jd-skill-extraction-golden-v1"},
        "projects": [baseline["project"], candidate["project"]],
    }

    overview = AppTest.from_function(
        render_overview_fixture,
        args=(inventory, comparison, baseline, candidate),
    ).run()

    assert not overview.exception
    assert any(item.value == "Baseline vs candidate scores" for item in overview.subheader)
    precision = next(
        item for item in overview.metric if item.label == "Candidate · Skill precision"
    )
    assert precision.value == "57.89%"
    assert precision.delta == "-2.11 pp"
    assert any(item.value == "Baseline 60.00%" for item in overview.caption)


def test_presentation_labels_are_human_readable_and_support_stays_a_count():
    assert metric_label("skill_canonical_precision") == "Skill precision"
    assert metric_label("skill_canonical_recall") == "Skill recall"
    assert metric_label("skill_requirement_accuracy") == "Requirement accuracy"
    assert metric_label("audit_category_label_accuracy") == "Category accuracy"
    assert metric_label("responsibility_support") == "Responsibility support"
    assert format_count(1.0) == "1"
    assert format_count(2.5) == "2.5"


def test_presentation_distinguishes_missing_from_a_valid_zero():
    assert format_score(None) == "—"
    assert format_score(0.0) == "0.00%"

    baseline = captured_experiment("project-1")
    baseline["runs"] = [
        run for run in baseline["runs"] if run["reference_example_id"] == "example-2"
    ]
    run_ids = {run["id"] for run in baseline["runs"]}
    baseline["feedback"] = [
        item for item in baseline["feedback"] if item["run_id"] in run_ids
    ]
    baseline["project"]["extra"]["metadata"]["fixture_count"] = 1
    candidate = copy.deepcopy(baseline)
    candidate["project"]["id"] = "same-fixture-candidate"
    candidate["project"]["name"] = "jd-skill-extraction-baseline-same-fixture"

    comparison = compare_experiments(baseline, candidate)
    row = fixture_metric_rows(
        comparison,
        baseline,
        candidate,
        "skill_alternative_group_accuracy",
    )[0]

    assert row["baseline"] == 0.0
    assert row["candidate"] == 0.0
    assert row["delta"] == 0.0
    assert row["status"] == "unchanged"


def test_errored_experiment_disables_presentation_deltas_and_outcomes():
    baseline = captured_experiment("project-1")
    candidate = captured_experiment("project-2")
    comparison = compare_experiments(baseline, candidate)

    rows = aggregate_metric_rows(comparison)
    fixtures = fixture_metric_rows(
        comparison, baseline, candidate, "skill_canonical_precision"
    )
    message = comparison_message(comparison, baseline, candidate)

    assert all(row["delta"] is None for row in rows)
    assert {row["golden"]: row["status"] for row in fixtures} == {
        "golden_003": "not comparable",
        "golden_001": "error",
    }
    assert fixture_outcome_counts(
        comparison, baseline, candidate, "skill_canonical_precision"
    ) is None
    assert message["headline"] == "Not fully comparable"
    assert "1 candidate fixture errored" in message["detail"]


def test_experiment_health_uses_declared_total_and_real_statuses():
    health = experiment_health(captured_experiment("project-2"))

    assert health == {"success": 1, "error": 1, "incomplete": 0, "total": 20}


def test_trend_rows_skip_incompatible_history_instead_of_implying_a_trend():
    baseline, candidate = one_fixture_pair()
    invalid = captured_experiment("project-2")
    invalid["project"]["id"] = "incompatible-history"

    result = trend_rows(candidate, [baseline, invalid])

    assert result["experiment_count"] == 2
    assert {point["experiment"] for point in result["points"]} == {
        "Aug 20, 2026 · 13:40 UTC",
        "Aug 21, 2026 · 04:23 UTC",
    }
    assert [item["label"] for item in result["skipped"]] == [
        "Aug 20, 2026 · 13:40 UTC"
    ]
