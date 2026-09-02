"""Render the local, read-only LangSmith JD evaluation decision dashboard.

This module owns Streamlit presentation and short-lived caching. It does NOT run
experiments, evaluators, models, or external writes. Invariant: comparative UI
is driven only by langsmith_dashboard's guarded comparison result.
"""

from __future__ import annotations

import json
import os
from typing import Any

import altair as alt
import pandas as pd
import streamlit as st
from dotenv import load_dotenv
from langsmith import Client

from langsmith_dashboard import (
    compare_experiments,
    historical_reference,
    list_jd_experiments,
    load_experiment,
    split_run_metrics,
)
from langsmith_dashboard_view import (
    PRIMARY_METRICS,
    STATUS_ORDER,
    aggregate_metric_rows,
    comparison_message,
    experiment_health,
    experiment_label,
    fixture_metric_rows,
    fixture_outcome_counts,
    format_count,
    format_delta,
    format_score,
    metric_label,
    trend_rows,
)


load_dotenv()
load_dotenv(".env.local")

BASELINE_COLOR = "#64748B"
CANDIDATE_COLOR = "#2563EB"
STATUS_COLORS = {"improved": "#16A34A", "regressed": "#DC2626", "unchanged": "#94A3B8"}
MAX_ADDITIONAL_HISTORY = 4


@st.cache_resource
def langsmith_client() -> Client:
    return Client()


@st.cache_data(ttl=60)
def cached_inventory() -> dict[str, Any]:
    return list_jd_experiments(langsmith_client())


@st.cache_data(ttl=60)
def cached_experiment(project_json: str) -> dict[str, Any]:
    return load_experiment(langsmith_client(), json.loads(project_json))


def _project_option(project: dict[str, Any]) -> str:
    model = project.get("extra", {}).get("metadata", {}).get("model")
    return f"{experiment_label(project)}{' · ' + model if model else ''}"


def _status_label(status: str) -> str:
    return status.capitalize()


def render_comparison_status(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    left_health = experiment_health(baseline)
    right_health = experiment_health(candidate)
    message = comparison_message(comparison, baseline, candidate)
    with st.container(border=True):
        left, middle, right = st.columns([1, 1, 2], vertical_alignment="center")
        left.markdown(f"**Baseline**  \n{left_health['success']}/{left_health['total']} successful")
        middle.markdown(f"**Candidate**  \n{right_health['success']}/{right_health['total']} successful")
        with right:
            text = f"**{message['headline']}** — {message['detail']}"
            if message["tone"] == "success":
                st.success(text, icon=":material/check_circle:")
            else:
                st.warning(text, icon=":material/warning:")


def render_kpi_cards(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    rows = aggregate_metric_rows(comparison, PRIMARY_METRICS[:3])
    left_health = experiment_health(baseline)
    right_health = experiment_health(candidate)
    columns = st.columns(4)
    for column, row in zip(columns[:3], rows):
        with column:
            st.metric(
                f"Candidate · {row['label']}",
                format_score(row["candidate"]),
                delta=format_delta(row["delta"]) if comparison["compatible"] else None,
                border=True,
                help=f"Baseline: {format_score(row['baseline'])} · Candidate: {format_score(row['candidate'])}",
            )
            st.caption(f"Baseline {format_score(row['baseline'])}")
    with columns[3]:
        reliability_delta = None
        if comparison["compatible"]:
            reliability_delta = f"{right_health['success'] - left_health['success']:+d} successful fixtures"
        st.metric(
            "Candidate · Run reliability",
            f"{right_health['success']}/{right_health['total']}",
            delta=reliability_delta,
            border=True,
        )
        st.caption(f"Baseline {left_health['success']}/{left_health['total']}")


def _grouped_metric_chart(rows: list[dict[str, Any]]) -> alt.Chart:
    records = [
        {"Metric": row["label"], "Experiment": experiment, "Score": value}
        for row in rows
        for experiment, value in (("Baseline", row["baseline"]), ("Candidate", row["candidate"]))
        if value is not None
    ]
    return (
        alt.Chart(pd.DataFrame(records))
        .mark_bar(cornerRadiusTopLeft=3, cornerRadiusTopRight=3)
        .encode(
            x=alt.X("Metric:N", title=None, sort=[row["label"] for row in rows]),
            xOffset="Experiment:N",
            y=alt.Y("Score:Q", title="Score", axis=alt.Axis(format="%"), scale=alt.Scale(domain=[0, 1])),
            color=alt.Color(
                "Experiment:N",
                scale=alt.Scale(domain=["Baseline", "Candidate"], range=[BASELINE_COLOR, CANDIDATE_COLOR]),
                legend=alt.Legend(orient="top"),
            ),
            tooltip=["Metric:N", "Experiment:N", alt.Tooltip("Score:Q", format=".2%")],
        )
        .properties(height=320)
    )


def _change_chart(rows: list[dict[str, Any]]) -> alt.Chart:
    records = []
    for row in rows:
        if row["delta"] is None:
            continue
        status = "unchanged" if abs(row["delta"]) <= 1e-9 else ("improved" if row["delta"] > 0 else "regressed")
        records.append({"Metric": row["label"], "Change": row["delta"] * 100, "Outcome": status})
    bars = (
        alt.Chart(pd.DataFrame(records))
        .mark_bar(cornerRadius=3)
        .encode(
            y=alt.Y("Metric:N", title=None, sort="-x"),
            x=alt.X("Change:Q", title="Change vs baseline (percentage points)"),
            color=alt.Color(
                "Outcome:N",
                scale=alt.Scale(domain=list(STATUS_COLORS), range=list(STATUS_COLORS.values())),
                legend=alt.Legend(orient="top"),
            ),
            tooltip=["Metric:N", alt.Tooltip("Change:Q", format="+.2f", title="Change (pp)"), "Outcome:N"],
        )
    )
    zero = alt.Chart(pd.DataFrame({"x": [0]})).mark_rule(color="#64748B").encode(x="x:Q")
    return (bars + zero).properties(height=260)


def _trend_chart(points: list[dict[str, Any]]) -> alt.Chart:
    frame = pd.DataFrame(points)[["experiment", "started_at", "label", "value"]]
    return (
        alt.Chart(frame)
        .mark_line(point=True, strokeWidth=2.5)
        .encode(
            x=alt.X("started_at:T", title="Experiment date"),
            y=alt.Y("value:Q", title="Score", axis=alt.Axis(format="%"), scale=alt.Scale(domain=[0, 1])),
            color=alt.Color("label:N", title="Metric", legend=alt.Legend(orient="top")),
            tooltip=["experiment:N", "label:N", alt.Tooltip("value:Q", format=".2%")],
        )
        .properties(height=330)
    )


def render_technical_info(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    with st.expander("Technical comparison details", icon=":material/info:"):
        st.caption(f"Baseline project: {baseline['project']['name']}")
        st.caption(f"Candidate project: {candidate['project']['name']}")
        if comparison["incompatibility_reasons"]:
            st.markdown("**Why comparisons are disabled**")
            for reason in comparison["incompatibility_reasons"]:
                st.write(f"- {reason}")
        coverage = [
            {
                "Metric": row["label"],
                "Baseline coverage": f"{row['baseline_coverage'][0]}/{row['baseline_coverage'][1]}",
                "Candidate coverage": f"{row['candidate_coverage'][0]}/{row['candidate_coverage'][1]}",
            }
            for row in aggregate_metric_rows(comparison)
        ]
        st.dataframe(pd.DataFrame(coverage), hide_index=True)


def render_outcome_summary(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    counts = fixture_outcome_counts(comparison, baseline, candidate, "skill_canonical_precision")
    st.subheader("Fixture outcomes for Skill precision")
    if counts is None:
        st.caption("Outcome counts are hidden because the selected experiments are not comparable.")
        return
    columns = st.columns(4)
    columns[0].metric("Improved", counts["improved"], border=True)
    columns[1].metric("Regressed", counts["regressed"], border=True)
    columns[2].metric("Unchanged", counts["unchanged"], border=True)
    unavailable = counts["error"] + counts["not comparable"] + counts["unavailable"]
    columns[3].metric("Errors / unavailable", unavailable, border=True)


def load_additional_history(
    projects: list[dict[str, Any]], selected_ids: set[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    experiments, failures = [], []
    candidates = [project for project in projects if project["id"] not in selected_ids]
    for project in candidates[:MAX_ADDITIONAL_HISTORY]:
        try:
            experiments.append(cached_experiment(json.dumps(project, sort_keys=True)))
        except Exception:
            failures.append(experiment_label(project))
    return experiments, failures


def render_overview(
    inventory: dict[str, Any], comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    st.header("Did the candidate make the system better?")
    render_comparison_status(comparison, baseline, candidate)
    render_kpi_cards(comparison, baseline, candidate)
    primary_rows = aggregate_metric_rows(comparison, PRIMARY_METRICS)
    if comparison["compatible"]:
        st.subheader("Baseline vs candidate scores")
    else:
        st.subheader("Raw scores — comparison disabled")
        st.caption(
            "These bars show each experiment's raw evaluator outputs. Do not interpret "
            "the gap between them as a measured improvement or regression."
        )
    st.altair_chart(_grouped_metric_chart(primary_rows), width="stretch")
    if comparison["compatible"]:
        left, right = st.columns([3, 2])
        with left.container(border=True):
            st.subheader("What improved or regressed?")
            st.altair_chart(_change_chart(primary_rows), width="stretch")
        with right.container(border=True):
            render_outcome_summary(comparison, baseline, candidate)
    else:
        st.caption("Change and fixture-outcome charts are withheld until both experiments pass the comparison gate.")

    st.subheader("Quality over time")
    if not comparison["compatible"]:
        st.caption("History is unavailable because the selected pair is not comparable.")
    else:
        load_history = st.toggle(
            "Load compatible experiment history",
            help=("Reads at most four additional experiments. Every point must pass the same "
                  "golden-set, completeness, and coverage checks as the selected comparison."),
            key="load_compatible_history",
        )
        if not load_history:
            st.caption("Turn on history to check whether quality is improving across versions.")
        else:
            with st.spinner("Loading compatible experiment history…"):
                extra, failures = load_additional_history(
                    inventory["projects"], {baseline["project"]["id"], candidate["project"]["id"]}
                )
                history = trend_rows(candidate, [baseline, *extra])
            if history["experiment_count"] < 3:
                st.info(
                    "Not enough compatible experiments for a meaningful trend. At least three complete, matching experiments are required.",
                    icon=":material/query_stats:",
                )
            else:
                st.altair_chart(_trend_chart(history["points"]), width="stretch")
            if history["skipped"] or failures:
                st.caption(
                    f"Skipped {len(history['skipped'])} incompatible and {len(failures)} unavailable historical experiments."
                )
    render_technical_info(comparison, baseline, candidate)


def _fixture_chart(rows: list[dict[str, Any]], metric: str) -> alt.Chart | None:
    records = [
        {
            "Golden fixture": row["golden"],
            "Experiment": experiment,
            "Value": value,
            "Status": _status_label(row["status"]),
            "Delta": row["delta"],
        }
        for row in rows
        for experiment, value in (("Baseline", row["baseline"]), ("Candidate", row["candidate"]))
        if value is not None
    ]
    if not records:
        return None
    order = [row["golden"] for row in rows]
    return (
        alt.Chart(pd.DataFrame(records))
        .mark_bar(cornerRadiusEnd=2)
        .encode(
            y=alt.Y("Golden fixture:N", title=None, sort=order),
            yOffset="Experiment:N",
            x=alt.X("Value:Q", title=metric_label(metric), axis=alt.Axis(format="%"), scale=alt.Scale(domain=[0, 1])),
            color=alt.Color(
                "Experiment:N",
                scale=alt.Scale(domain=["Baseline", "Candidate"], range=[BASELINE_COLOR, CANDIDATE_COLOR]),
                legend=alt.Legend(orient="top"),
            ),
            tooltip=["Golden fixture:N", "Experiment:N", alt.Tooltip("Value:Q", format=".2%"),
                     alt.Tooltip("Delta:Q", format="+.2%"), "Status:N"],
        )
        .properties(height=max(280, min(720, len(order) * 30)))
    )


def render_metric_table(rows: list[dict[str, Any]]) -> None:
    display = pd.DataFrame(
        [{
            "Golden fixture": row["golden"],
            "Status": _status_label(row["status"]),
            "Baseline": format_score(row["baseline"]),
            "Candidate": format_score(row["candidate"]),
            "Change": format_delta(row["delta"]),
        } for row in rows]
    )
    st.dataframe(display, hide_index=True)


def render_run_detail(title: str, run: dict[str, Any] | None, experiment: dict[str, Any]) -> None:
    st.markdown(f"#### {title}")
    if run is None:
        st.warning("No matching run exists in this experiment.", icon=":material/warning:")
        return
    metadata = run["extra"]["metadata"]
    st.markdown(f"**Run status:** {str(run['status']).capitalize()}")
    st.caption(f"Model: {metadata.get('model', 'Unavailable')}")
    if run["error"] or run["status"] == "error":
        st.error(run["error"] or "LangSmith marked this run as an error without an error message.", icon=":material/error:")
    if run.get("url"):
        st.link_button("Open run in LangSmith", run["url"], icon=":material/open_in_new:")
    expected = historical_reference(run, experiment)
    with st.expander("Historical expected output", icon=":material/fact_check:"):
        if expected is None:
            st.warning("Historical reference unavailable; the current dataset reference was not substituted.")
        else:
            st.json(expected, expanded=False)
    with st.expander("Prediction", icon=":material/data_object:"):
        st.json(run["outputs"], expanded=False)
    metrics = split_run_metrics(run, experiment)
    if metrics["quality"]:
        st.markdown("**Quality metrics**")
        st.dataframe(pd.DataFrame([
            {"Metric": metric_label(key), "Value": format_score(value)}
            for key, value in sorted(metrics["quality"].items())
        ]), hide_index=True)
    if metrics["context"]:
        st.markdown("**Support / context counts**")
        st.dataframe(pd.DataFrame([
            {"Metric": metric_label(key), "Count": format_count(value)}
            for key, value in sorted(metrics["context"].items())
        ]), hide_index=True)
    if metrics["unknown"]:
        with st.expander("Unrecognized evaluator feedback", icon=":material/code:"):
            st.dataframe(pd.DataFrame([
                {"Metric": metric_label(key), "Value": value}
                for key, value in sorted(metrics["unknown"].items())
            ]), hide_index=True)


def render_engineering(
    comparison: dict[str, Any], baseline: dict[str, Any], candidate: dict[str, Any]
) -> None:
    st.header("Eval Debugger")
    st.caption("Find the fixtures that drove a change, then inspect their expected and predicted outputs.")
    render_comparison_status(comparison, baseline, candidate)
    render_kpi_cards(comparison, baseline, candidate)
    metric_keys = [row["metric"] for row in aggregate_metric_rows(comparison)]
    ordered = [key for key in PRIMARY_METRICS if key in metric_keys]
    ordered.extend(sorted((key for key in metric_keys if key not in ordered), key=metric_label))
    selected_metric = st.selectbox("Metric to investigate", ordered, format_func=metric_label, index=0)
    all_rows = fixture_metric_rows(comparison, baseline, candidate, selected_metric)
    selected_statuses = st.pills(
        "Fixture outcomes", STATUS_ORDER, default=list(STATUS_ORDER), selection_mode="multi",
        format_func=_status_label, width="stretch",
    )
    filtered = [row for row in all_rows if row["status"] in (selected_statuses or [])]
    st.subheader(f"Fixtures by {metric_label(selected_metric)}")
    chart = _fixture_chart(filtered, selected_metric)
    if chart is None:
        st.info("No metric values match the current filters.")
    else:
        st.altair_chart(chart, width="stretch")
    render_metric_table(filtered)
    if not filtered:
        st.caption("Select additional outcome filters to inspect fixture details.")
        return
    selected_golden = st.selectbox("Inspect a golden fixture", [row["golden"] for row in filtered])
    detail = next(row for row in filtered if row["golden"] == selected_golden)
    st.subheader(f"Why did {selected_golden} behave this way?")
    baseline_column, candidate_column = st.columns(2)
    with baseline_column.container(border=True):
        render_run_detail("Baseline", detail["comparison_row"]["baseline_run"], baseline)
    with candidate_column.container(border=True):
        render_run_detail("Candidate", detail["comparison_row"]["candidate_run"], candidate)


def main() -> None:
    st.set_page_config(page_title="JD evaluation dashboard", page_icon=":material/analytics:", layout="wide")
    st.title("JD extraction evaluation")
    st.caption("A read-only decision view over the committed golden evaluation set.")
    if not os.getenv("LANGSMITH_API_KEY"):
        st.error("LANGSMITH_API_KEY is missing. Set it in .env.local or the process environment.")
        st.stop()
    if st.sidebar.button("Refresh evaluation data", icon=":material/refresh:"):
        cached_inventory.clear()
        cached_experiment.clear()
        st.rerun()
    try:
        inventory = cached_inventory()
    except Exception:
        st.error("Could not load the experiment inventory from LangSmith.")
        st.stop()
    projects = inventory["projects"]
    if len(projects) < 2:
        st.warning("At least two JD extraction experiments are required for comparison.")
        st.stop()
    projects_by_name = {project["name"]: project for project in projects}
    names = list(projects_by_name)
    st.sidebar.markdown("### Compare experiments")
    baseline_name = st.sidebar.selectbox(
        "Baseline", names, index=1, format_func=lambda name: _project_option(projects_by_name[name])
    )
    candidate_options = [name for name in names if name != baseline_name]
    candidate_default = candidate_options.index(names[0]) if names[0] in candidate_options else 0
    candidate_name = st.sidebar.selectbox(
        "Candidate", candidate_options, index=candidate_default,
        format_func=lambda name: _project_option(projects_by_name[name]),
    )
    with st.sidebar.expander("Data source details", icon=":material/database:"):
        st.caption(f"Golden set: {inventory['dataset']['name']}")
        st.caption("Read-only · 60-second cache · no model calls")
    try:
        with st.spinner("Loading selected experiment results…"):
            baseline = cached_experiment(json.dumps(projects_by_name[baseline_name], sort_keys=True))
            candidate = cached_experiment(json.dumps(projects_by_name[candidate_name], sort_keys=True))
        comparison = compare_experiments(baseline, candidate)
    except Exception:
        st.error("Could not load the selected experiment results.")
        st.stop()
    view = st.segmented_control(
        "Dashboard view", ["Overview", "Eval Debugger"], default="Overview", required=True,
        key="dashboard_view", width="stretch",
    )
    if view == "Overview":
        render_overview(inventory, comparison, baseline, candidate)
    else:
        render_engineering(comparison, baseline, candidate)


if __name__ == "__main__":
    main()
