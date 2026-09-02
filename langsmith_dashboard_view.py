"""Prepare LangSmith comparison results for human-facing dashboard views.

This module owns labels, display formatting, and chart/table view models. It does
NOT query LangSmith, change comparison eligibility, render Streamlit, or fill in
missing values. Invariants: zero remains a real value, support remains a count,
and comparative statuses are emitted only when the adapter supplied a delta.
"""

from __future__ import annotations

import math
from collections import Counter
from datetime import datetime
from typing import Any, Iterable

from langsmith_dashboard import FLOAT_TOLERANCE, compare_experiments, split_run_metrics


PRIMARY_METRICS = (
    "skill_canonical_precision",
    "skill_canonical_recall",
    "skill_requirement_accuracy",
    "audit_category_label_accuracy",
)

METRIC_LABELS = {
    "skill_canonical_precision": "Skill precision",
    "skill_canonical_recall": "Skill recall",
    "skill_requirement_accuracy": "Requirement accuracy",
    "skill_alternative_group_accuracy": "Alternative-group accuracy",
    "non_skill_precision": "Non-skill precision",
    "non_skill_recall": "Non-skill recall",
    "audit_category_label_accuracy": "Category accuracy",
    "audit_structured_accuracy": "Structured-field accuracy",
}

STATUS_ORDER = (
    "improved",
    "regressed",
    "unchanged",
    "error",
    "not comparable",
    "unavailable",
)


def metric_label(key: str) -> str:
    """Return a stable stakeholder label for an evaluator or support key."""
    if key in METRIC_LABELS:
        return METRIC_LABELS[key]
    words = key.removesuffix("_support").replace("_", " ")
    label = words.capitalize()
    return f"{label} support" if key.endswith("_support") else label


def format_score(value: float | None) -> str:
    """Format a 0–1 quality score without treating missing as zero."""
    return "—" if value is None else f"{value:.2%}"


def format_delta(value: float | None) -> str:
    """Format a score delta as percentage points, preserving missingness."""
    return "—" if value is None else f"{value * 100:+.2f} pp"


def format_count(value: float | int | None) -> str:
    """Format support as a count rather than a percentage."""
    if value is None:
        return "—"
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:g}"


def experiment_label(project: dict[str, Any]) -> str:
    """Give an experiment a readable date label without exposing its hash-like name."""
    timestamp = project.get("start_time")
    if timestamp:
        started = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        return started.strftime("%b %d, %Y · %H:%M UTC")
    return "Experiment date unavailable"


def experiment_health(experiment: dict[str, Any]) -> dict[str, int]:
    """Count successful, errored, and incomplete root fixtures."""
    statuses = Counter(run.get("status") for run in experiment["runs"])
    declared = experiment["project"].get("extra", {}).get("metadata", {}).get("fixture_count")
    total = declared if isinstance(declared, int) and declared > 0 else len(experiment["runs"])
    return {
        "success": statuses["success"],
        "error": statuses["error"],
        "incomplete": sum(
            count for status, count in statuses.items() if status not in {"success", "error"}
        ),
        "total": total,
    }


def comparison_message(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, str]:
    """Explain comparison eligibility without leaking adapter implementation details."""
    if comparison["compatible"]:
        return {
            "tone": "success",
            "headline": "Comparison ready",
            "detail": "Both experiments completed the same golden fixtures, so changes can be compared.",
        }
    baseline_health = experiment_health(baseline)
    candidate_health = experiment_health(candidate)
    problems = []
    if baseline_health["error"]:
        problems.append(f"{baseline_health['error']} baseline fixture errored")
    if candidate_health["error"]:
        problems.append(f"{candidate_health['error']} candidate fixture errored")
    if baseline_health["incomplete"]:
        problems.append(f"{baseline_health['incomplete']} baseline fixture incomplete")
    if candidate_health["incomplete"]:
        problems.append(f"{candidate_health['incomplete']} candidate fixture incomplete")
    detail = "; ".join(problems)
    if not detail:
        detail = "The experiments differ in coverage or golden-set identity."
    return {
        "tone": "warning",
        "headline": "Not fully comparable",
        "detail": f"{detail}. Comparative claims and deltas are disabled.",
    }


def aggregate_metric_rows(
    comparison: dict[str, Any], metrics: Iterable[str] | None = None
) -> list[dict[str, Any]]:
    """Build readable aggregate rows while preserving the adapter's delta gate."""
    requested = tuple(metrics) if metrics is not None else None
    by_key = {row["metric"]: row for row in comparison["aggregate_rows"]}
    keys = requested or tuple(by_key)
    rows = []
    for key in keys:
        row = by_key.get(key, {})
        baseline = row.get("baseline") or {}
        candidate = row.get("candidate") or {}
        rows.append(
            {
                "metric": key,
                "label": metric_label(key),
                "baseline": baseline.get("mean"),
                "candidate": candidate.get("mean"),
                "delta": row.get("delta"),
                "baseline_coverage": (
                    baseline.get("returned", 0), baseline.get("applicable", 0)
                ),
                "candidate_coverage": (
                    candidate.get("returned", 0), candidate.get("applicable", 0)
                ),
            }
        )
    return rows


def metric_fixture_status(row: dict[str, Any], metric: str) -> str:
    """Classify one fixture for one metric using only guarded adapter deltas."""
    if row["status"] == "error":
        return "error"
    if row["status"] == "not comparable":
        return "not comparable"
    delta = row.get("deltas", {}).get(metric)
    if delta is None:
        return "unavailable"
    if math.isclose(delta, 0, rel_tol=0, abs_tol=FLOAT_TOLERANCE):
        return "unchanged"
    return "improved" if delta > 0 else "regressed"


def fixture_metric_rows(
    comparison: dict[str, Any],
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    metric: str,
) -> list[dict[str, Any]]:
    """Build per-fixture values sorted with the worst valid regressions first."""
    rows = []
    for row in comparison["rows"]:
        baseline_split = split_run_metrics(row["baseline_run"], baseline)
        candidate_split = split_run_metrics(row["candidate_run"], candidate)
        baseline_scores = {**baseline_split["quality"], **baseline_split["context"]}
        candidate_scores = {**candidate_split["quality"], **candidate_split["context"]}
        delta = row.get("deltas", {}).get(metric)
        rows.append(
            {
                "golden": str(row["label"]),
                "status": metric_fixture_status(row, metric),
                "baseline": baseline_scores.get(metric),
                "candidate": candidate_scores.get(metric),
                "delta": delta,
                "comparison_row": row,
            }
        )
    return sorted(
        rows,
        key=lambda item: (
            item["delta"] is None,
            item["delta"] if item["delta"] is not None else math.inf,
            item["golden"],
        ),
    )


def fixture_outcome_counts(
    comparison: dict[str, Any],
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    metric: str,
) -> dict[str, int] | None:
    """Count metric-specific outcomes only for a globally valid comparison."""
    if not comparison["compatible"]:
        return None
    counts = Counter(
        row["status"] for row in fixture_metric_rows(comparison, baseline, candidate, metric)
    )
    return {status: counts[status] for status in STATUS_ORDER}


def trend_rows(
    anchor: dict[str, Any],
    experiments: Iterable[dict[str, Any]],
    metrics: Iterable[str] = PRIMARY_METRICS,
) -> dict[str, Any]:
    """Keep only experiments fully comparable to the anchor for every primary metric."""
    metric_keys = tuple(metrics)
    candidates = [anchor, *experiments]
    seen = set()
    points = []
    skipped = []
    for experiment in candidates:
        project = experiment["project"]
        project_id = project["id"]
        if project_id in seen:
            continue
        seen.add(project_id)
        comparison = compare_experiments(anchor, experiment)
        rows = {row["metric"]: row for row in comparison["aggregate_rows"]}
        comparable_metrics = all(
            key in rows and rows[key]["delta"] is not None for key in metric_keys
        )
        if not comparison["compatible"] or not comparable_metrics:
            skipped.append(
                {
                    "label": experiment_label(project),
                    "reasons": comparison["incompatibility_reasons"]
                    or ["one or more primary metrics lacked comparable coverage"],
                }
            )
            continue
        for key in metric_keys:
            points.append(
                {
                    "experiment": experiment_label(project),
                    "started_at": project.get("start_time"),
                    "metric": key,
                    "label": metric_label(key),
                    "value": (rows[key]["candidate"] or {}).get("mean"),
                }
            )
    points.sort(key=lambda point: (point["started_at"] or "", point["metric"]))
    return {"points": points, "skipped": skipped, "experiment_count": len(seen) - len(skipped)}
