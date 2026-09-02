"""Read and compare JD extraction experiments from LangSmith.

This module owns the read-only LangSmith boundary and deterministic comparison
rules. It does NOT render Streamlit, run evaluators or models, download
attachments, or write to any external system. Invariants: missing feedback is
never zero-filled, historical references determine applicability, and deltas are
emitted only for complete experiments over the same fixture identity.
"""

from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable


DATASET_NAME = "jd-skill-extraction-golden-v1"
EXPERIMENT_PREFIX = "jd-skill-extraction-baseline"
MAX_PROJECTS = 50
FLOAT_TOLERANCE = 1e-9

CORE_METRICS = frozenset(
    {
        "skill_canonical_precision",
        "skill_canonical_recall",
        "skill_requirement_accuracy",
        "non_skill_precision",
        "non_skill_recall",
        "audit_category_label_accuracy",
        "audit_structured_accuracy",
    }
)
ALTERNATIVE_METRIC = "skill_alternative_group_accuracy"
REPORTED_NON_SKILL_CATEGORIES = (
    "qualification",
    "experience_requirement",
    "soft_skill",
    "eligibility",
    "language_requirement",
    "responsibility",
)
LEGACY_ALIASES = {
    "technical_canonical_precision": "skill_canonical_precision",
    "technical_canonical_recall": "skill_canonical_recall",
    "technical_requirement_accuracy": "skill_requirement_accuracy",
    "technical_alternative_group_accuracy": ALTERNATIVE_METRIC,
    "audit_source_text_precision": "non_skill_precision",
    "audit_source_text_recall": "non_skill_recall",
    "audit_category_accuracy": "audit_category_label_accuracy",
}
QUALITY_METRICS = CORE_METRICS | {ALTERNATIVE_METRIC} | {
    f"{category}_{suffix}"
    for category in REPORTED_NON_SKILL_CATEGORIES
    for suffix in ("precision", "recall")
}
RUN_SELECTS = [
    "ID",
    "NAME",
    "STATUS",
    "START_TIME",
    "END_TIME",
    "ERROR",
    "METADATA",
    "INPUTS",
    "OUTPUTS",
    "PROJECT_ID",
    "TRACE_ID",
    "REFERENCE_EXAMPLE_ID",
]


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _iso(value: datetime | str | None) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else value


def parse_timestamp(value: datetime | str) -> datetime:
    """Turn LangSmith's ISO metadata timestamp into the SDK's datetime input."""
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _metadata(value: Any) -> dict[str, Any]:
    direct = _field(value, "metadata")
    if direct:
        return dict(direct)
    return dict((_field(value, "extra", {}) or {}).get("metadata", {}) or {})


def normalized_metric(key: str) -> str:
    return LEGACY_ALIASES.get(key, key)


def metric_role(key: str) -> str:
    canonical = normalized_metric(key)
    if canonical in QUALITY_METRICS:
        return "quality"
    if canonical.endswith("_support"):
        return "context"
    return "unknown"


def list_jd_experiments(client: Any) -> dict[str, Any]:
    """List only experiment projects attached to the fixed JD golden dataset."""
    dataset = client.read_dataset(dataset_name=DATASET_NAME)
    dataset_id = str(dataset.id)
    projects = []
    for project in client.list_projects(
        reference_dataset_id=dataset.id,
        name_contains=EXPERIMENT_PREFIX,
        include_stats=True,
        limit=MAX_PROJECTS,
    ):
        reference_dataset_id = str(_field(project, "reference_dataset_id", ""))
        if reference_dataset_id != dataset_id:
            raise ValueError(
                f"{project.name}: expected reference dataset {dataset_id}, got "
                f"{reference_dataset_id or 'missing'}"
            )
        if not project.name.startswith(EXPERIMENT_PREFIX):
            continue
        projects.append(
            {
                "id": str(project.id),
                "name": project.name,
                "reference_dataset_id": reference_dataset_id,
                "tenant_id": str(_field(project, "tenant_id", "")),
                "start_time": _iso(project.start_time),
                "end_time": _iso(project.end_time),
                "run_count": project.run_count,
                "error_rate": project.error_rate,
                "extra": {"metadata": _metadata(project)},
                "host_url": getattr(client, "_host_url", "https://smith.langchain.com"),
            }
        )
    projects.sort(key=lambda project: project["start_time"] or "", reverse=True)
    return {"dataset": {"id": dataset_id, "name": dataset.name}, "projects": projects}


async def _query_root_runs(client: Any, project: dict[str, Any], limit: int) -> list[Any]:
    page = await client.runs.query(
        project_ids=[project["id"]],
        is_root=True,
        min_start_time=parse_timestamp(project["start_time"]),
        page_size=limit,
        selects=RUN_SELECTS,
    )
    runs = []
    async for run in page:
        runs.append(run)
        if len(runs) == limit:
            break
    return runs


def _run_url(project: dict[str, Any], run_id: str) -> str | None:
    if not project.get("tenant_id"):
        return None
    host = project["host_url"].rstrip("/")
    return f"{host}/o/{project['tenant_id']}/projects/p/{project['id']}/r/{run_id}?poll=true"


def _normalize_run(run: Any, project: dict[str, Any]) -> dict[str, Any]:
    run_id = str(_field(run, "id"))
    status = str(_field(run, "status", "")).lower()
    return {
        "id": run_id,
        "project_id": str(_field(run, "project_id", project["id"])),
        "reference_example_id": (
            str(_field(run, "reference_example_id"))
            if _field(run, "reference_example_id") is not None
            else None
        ),
        "trace_id": str(_field(run, "trace_id", run_id)),
        "name": _field(run, "name"),
        "start_time": _iso(_field(run, "start_time")),
        "end_time": _iso(_field(run, "end_time")),
        "status": status,
        "error": _field(run, "error"),
        "inputs": _field(run, "inputs", {}) or {},
        "outputs": _field(run, "outputs", {}) or {},
        "extra": {"metadata": _metadata(run)},
        "url": _run_url(project, run_id),
    }


def load_experiment(client: Any, project: dict[str, Any]) -> dict[str, Any]:
    """Load one experiment without attachments, writes, or model calls."""
    fixture_count = project.get("extra", {}).get("metadata", {}).get("fixture_count")
    run_limit = fixture_count + 1 if isinstance(fixture_count, int) and fixture_count > 0 else 21
    raw_runs = asyncio.run(_query_root_runs(client, project, run_limit))
    runs = [_normalize_run(run, project) for run in raw_runs]
    run_ids = [run["id"] for run in runs]
    feedback = [
        {
            "id": str(item.id),
            "run_id": str(item.run_id),
            "key": item.key,
            "score": item.score,
        }
        for item in client.list_feedback(run_ids=run_ids)
        if item.score is not None
    ]

    examples = []
    example_errors = []
    seen = set()
    for run in runs:
        reference_id = run["reference_example_id"]
        version = run["extra"]["metadata"].get("example_version")
        key = (reference_id, version)
        if not reference_id or not version or key in seen:
            continue
        seen.add(key)
        try:
            example = client.read_example(reference_id, as_of=parse_timestamp(version))
        except Exception as exc:  # An unavailable historical version is visible, not fatal.
            example_errors.append(
                {"reference_example_id": reference_id, "as_of": version, "error": str(exc)}
            )
            continue
        examples.append(
            {
                "id": str(example.id),
                "as_of": version,
                "inputs": example.inputs,
                "outputs": example.outputs,
            }
        )
    return {
        "project": project,
        "runs": runs,
        "feedback": feedback,
        "historical_examples": examples,
        "historical_example_errors": example_errors,
    }


def feedback_by_run(experiment: dict[str, Any]) -> dict[str, dict[str, float]]:
    grouped: dict[str, dict[str, float]] = defaultdict(dict)
    for item in experiment["feedback"]:
        key = normalized_metric(item["key"])
        if key in grouped[item["run_id"]]:
            raise ValueError(f"duplicate normalized feedback key {key} on {item['run_id']}")
        grouped[item["run_id"]][key] = item["score"]
    return dict(grouped)


def _historical_index(experiment: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {
        (example["id"], example["as_of"]): example
        for example in experiment["historical_examples"]
    }


def historical_reference(
    run: dict[str, Any], experiment: dict[str, Any]
) -> dict[str, Any] | None:
    version = run["extra"]["metadata"].get("example_version")
    example = _historical_index(experiment).get((run["reference_example_id"], version))
    return (example or {}).get("outputs", {}).get("expected_extraction")


def applicable_metrics(
    run: dict[str, Any], experiment: dict[str, Any]
) -> set[str] | None:
    if run["status"] != "success":
        return set()
    expected = historical_reference(run, experiment)
    if expected is None:
        return None
    applicable = set(CORE_METRICS)
    if any(
        skill.get("alternative_group") is not None
        for skill in expected.get("technical_skills", [])
    ):
        applicable.add(ALTERNATIVE_METRIC)
    mentions = expected.get("non_skill_mentions", [])
    for category in REPORTED_NON_SKILL_CATEGORIES:
        if any(mention.get("category") == category for mention in mentions):
            applicable.update({f"{category}_precision", f"{category}_recall"})
    return applicable


def experiment_integrity(experiment: dict[str, Any]) -> list[str]:
    project = experiment["project"]
    runs = experiment["runs"]
    metadata = project.get("extra", {}).get("metadata", {})
    count = metadata.get("fixture_count")
    reasons = []
    if not isinstance(count, int) or count <= 0:
        reasons.append(f"{project['name']}: fixture_count is missing or invalid")
    elif len(runs) != count:
        reasons.append(f"{project['name']}: observed {len(runs)} roots, declared {count}")
    references = [run.get("reference_example_id") for run in runs]
    if any(reference is None for reference in references):
        reasons.append(f"{project['name']}: a root run has no reference_example_id")
    if len(set(references)) != len(references):
        reasons.append(f"{project['name']}: duplicate reference_example_id")
    if any(run["status"] == "error" for run in runs):
        reasons.append(f"{project['name']}: contains an error run")
    if any(run["status"] not in {"success", "error"} for run in runs):
        reasons.append(f"{project['name']}: contains an incomplete run")
    return reasons


def aggregate_metrics(experiment: dict[str, Any]) -> dict[str, Any]:
    scores = feedback_by_run(experiment)
    values: dict[str, list[tuple[str, float]]] = defaultdict(list)
    applicable_ids: dict[str, set[str]] = defaultdict(set)
    unknown_references = []
    for run in experiment["runs"]:
        if run["status"] != "success":
            continue
        applicable = applicable_metrics(run, experiment)
        if applicable is None:
            unknown_references.append(run["reference_example_id"])
            applicable = set(CORE_METRICS)
        for key in applicable:
            applicable_ids[key].add(run["reference_example_id"])
            if key in scores.get(run["id"], {}):
                values[key].append((run["reference_example_id"], scores[run["id"]][key]))
    metrics = {}
    for key in sorted(applicable_ids):
        returned = values.get(key, [])
        metrics[key] = {
            "mean": sum(value for _, value in returned) / len(returned) if returned else None,
            "returned": len(returned),
            "applicable": len(applicable_ids[key]),
            "contributor_ids": sorted(reference_id for reference_id, _ in returned),
            "applicability_known": key in CORE_METRICS or not unknown_references,
            "unknown_applicability": 0 if key in CORE_METRICS else len(unknown_references),
        }
    return {"metrics": metrics, "unknown_reference_ids": sorted(unknown_references)}


def _global_compatibility(
    baseline: dict[str, Any], candidate: dict[str, Any]
) -> tuple[bool, list[str]]:
    reasons = experiment_integrity(baseline) + experiment_integrity(candidate)
    baseline_metadata = baseline["project"].get("extra", {}).get("metadata", {})
    candidate_metadata = candidate["project"].get("extra", {}).get("metadata", {})
    manifests = [
        baseline_metadata.get("fixture_manifest_sha256"),
        candidate_metadata.get("fixture_manifest_sha256"),
    ]
    counts = [baseline_metadata.get("fixture_count"), candidate_metadata.get("fixture_count")]
    if not all(manifests) or manifests[0] != manifests[1]:
        reasons.append("fixture manifests differ or are missing")
    if not all(isinstance(count, int) and count > 0 for count in counts) or counts[0] != counts[1]:
        reasons.append("declared fixture counts differ or are invalid")
    baseline_ids = {run["reference_example_id"] for run in baseline["runs"]}
    candidate_ids = {run["reference_example_id"] for run in candidate["runs"]}
    if baseline_ids != candidate_ids:
        reasons.append("full reference_example_id sets differ")
    return not reasons, reasons


def classify_row(
    baseline_run: dict[str, Any] | None,
    candidate_run: dict[str, Any] | None,
    baseline_applicable: set[str] | None,
    candidate_applicable: set[str] | None,
    baseline_scores: dict[str, float],
    candidate_scores: dict[str, float],
    globally_compatible: bool,
) -> tuple[str, dict[str, float]]:
    """Classify one fixture with conservative missing-data precedence."""
    if any(run and run["status"] == "error" for run in (baseline_run, candidate_run)):
        return "error", {}
    if (
        baseline_run is None
        or candidate_run is None
        or baseline_applicable is None
        or candidate_applicable is None
    ):
        return "unavailable", {}
    if not globally_compatible:
        return "not comparable", {}
    if baseline_applicable != candidate_applicable or not baseline_applicable:
        return "unavailable", {}
    if not baseline_applicable.issubset(baseline_scores) or not candidate_applicable.issubset(candidate_scores):
        return "unavailable", {}
    deltas = {
        key: candidate_scores[key] - baseline_scores[key] for key in sorted(baseline_applicable)
    }
    signs = {
        0 if math.isclose(delta, 0, rel_tol=0, abs_tol=FLOAT_TOLERANCE) else (1 if delta > 0 else -1)
        for delta in deltas.values()
    }
    signs.discard(0)
    if not signs:
        return "unchanged", deltas
    if signs == {1}:
        return "improved", deltas
    if signs == {-1}:
        return "regressed", deltas
    return "mixed", deltas


def compare_experiments(
    baseline: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    compatible, reasons = _global_compatibility(baseline, candidate)
    baseline_scores = feedback_by_run(baseline)
    candidate_scores = feedback_by_run(candidate)
    baseline_runs = {run["reference_example_id"]: run for run in baseline["runs"]}
    candidate_runs = {run["reference_example_id"]: run for run in candidate["runs"]}
    rows = []
    for reference_id in sorted(set(baseline_runs) | set(candidate_runs), key=lambda value: str(value)):
        baseline_run = baseline_runs.get(reference_id)
        candidate_run = candidate_runs.get(reference_id)
        baseline_applicable = applicable_metrics(baseline_run, baseline) if baseline_run else None
        candidate_applicable = applicable_metrics(candidate_run, candidate) if candidate_run else None
        status, deltas = classify_row(
            baseline_run,
            candidate_run,
            baseline_applicable,
            candidate_applicable,
            baseline_scores.get(baseline_run["id"], {}) if baseline_run else {},
            candidate_scores.get(candidate_run["id"], {}) if candidate_run else {},
            compatible,
        )
        label = next(
            (
                run["extra"]["metadata"].get("ls_example_id")
                for run in (baseline_run, candidate_run)
                if run and run["extra"]["metadata"].get("ls_example_id")
            ),
            reference_id or "unmapped",
        )
        rows.append(
            {
                "label": label,
                "reference_example_id": reference_id,
                "status": status,
                "deltas": deltas,
                "baseline_run": baseline_run,
                "candidate_run": candidate_run,
            }
        )

    baseline_aggregate = aggregate_metrics(baseline)
    candidate_aggregate = aggregate_metrics(candidate)
    aggregate_rows = []
    all_metrics = sorted(
        set(baseline_aggregate["metrics"]) | set(candidate_aggregate["metrics"])
    )
    for key in all_metrics:
        left = baseline_aggregate["metrics"].get(key)
        right = candidate_aggregate["metrics"].get(key)
        delta = None
        if (
            compatible
            and left
            and right
            and left["applicability_known"]
            and right["applicability_known"]
            and left["mean"] is not None
            and right["mean"] is not None
            and left["contributor_ids"] == right["contributor_ids"]
        ):
            delta = right["mean"] - left["mean"]
        aggregate_rows.append(
            {"metric": key, "baseline": left, "candidate": right, "delta": delta}
        )
    return {
        "compatible": compatible,
        "incompatibility_reasons": reasons,
        "baseline_aggregate": baseline_aggregate,
        "candidate_aggregate": candidate_aggregate,
        "aggregate_rows": aggregate_rows,
        "rows": rows,
    }


def split_run_metrics(
    run: dict[str, Any] | None, experiment: dict[str, Any]
) -> dict[str, dict[str, float]]:
    if run is None:
        return {"quality": {}, "context": {}, "unknown": {}}
    scores = feedback_by_run(experiment).get(run["id"], {})
    split = {"quality": {}, "context": {}, "unknown": {}}
    for key, score in scores.items():
        split[metric_role(key)][key] = score
    return split
