from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", tempfile.mkdtemp(prefix="matplotlib-"))

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

EVAL_ROOT = Path(__file__).resolve().parent.parent


def resolve_path(path_value: str) -> Path:
    candidate = Path(path_value)
    if candidate.is_absolute():
        return candidate
    if candidate.exists():
        return candidate
    cwd_candidate = Path.cwd() / candidate
    if cwd_candidate.parent.exists():
        return cwd_candidate
    return EVAL_ROOT / candidate


def load_csv(path: Path) -> pd.DataFrame:
    if path.exists():
        return pd.read_csv(path)
    return pd.DataFrame()


def save_plot(fig: plt.Figure, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(output_path, dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_provider_accuracy(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty:
        return []
    fig, ax = plt.subplots(figsize=(12, 6))
    chart_df = summary.sort_values(["verdict_accuracy", "success_rate"], ascending=[False, False]).copy()
    chart_df["label"] = chart_df["provider"] + "\n" + chart_df["provider_mode"]
    sns.barplot(data=chart_df, x="label", y="verdict_accuracy", hue="provider", ax=ax)
    ax.set_title("Verdict Accuracy By Provider Mode")
    ax.set_xlabel("")
    ax.set_ylabel("Accuracy")
    ax.tick_params(axis="x", rotation=0)
    path = output_dir / "provider_accuracy.png"
    save_plot(fig, path)
    return [path.name]


def plot_success_vs_latency(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty:
        return []
    fig, ax = plt.subplots(figsize=(10, 6))
    scatter = summary.copy()
    sns.scatterplot(
        data=scatter,
        x="mean_latency_ms",
        y="success_rate",
        hue="provider",
        size="runs",
        style="provider_mode",
        sizes=(120, 500),
        ax=ax,
    )
    ax.set_title("Success Rate vs Mean Latency")
    ax.set_xlabel("Mean latency (ms)")
    ax.set_ylabel("Success rate")
    path = output_dir / "success_vs_latency.png"
    save_plot(fig, path)
    return [path.name]


def plot_latency_distribution(details: pd.DataFrame, output_dir: Path) -> list[str]:
    if details.empty:
        return []
    fig, ax = plt.subplots(figsize=(12, 6))
    sns.boxplot(data=details, x="provider", y="latency_ms", hue="provider_mode", ax=ax)
    ax.set_title("Latency Distribution By Provider")
    ax.set_xlabel("")
    ax.set_ylabel("Latency (ms)")
    path = output_dir / "latency_distribution.png"
    save_plot(fig, path)
    return [path.name]


def plot_cost(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty or "mean_cost_estimate" not in summary.columns:
        return []
    cost_df = summary[summary["mean_cost_estimate"].fillna(0) > 0].copy()
    if cost_df.empty:
        return []
    fig, ax = plt.subplots(figsize=(12, 6))
    cost_df["label"] = cost_df["provider"] + "\n" + cost_df["provider_mode"]
    sns.barplot(data=cost_df, x="label", y="mean_cost_estimate", hue="provider", ax=ax)
    if {
        "mean_cost_estimate_low",
        "mean_cost_estimate_high",
    }.issubset(cost_df.columns):
        x_positions = ax.get_xticks()
        lower_errors = (cost_df["mean_cost_estimate"] - cost_df["mean_cost_estimate_low"]).clip(lower=0)
        upper_errors = (cost_df["mean_cost_estimate_high"] - cost_df["mean_cost_estimate"]).clip(lower=0)
        ax.errorbar(
            x_positions,
            cost_df["mean_cost_estimate"],
            yerr=[lower_errors.to_numpy(), upper_errors.to_numpy()],
            fmt="none",
            ecolor="black",
            elinewidth=1,
            capsize=4,
        )
    ax.set_title("Mean Cost Estimate By Provider Mode")
    ax.set_xlabel("")
    ax.set_ylabel("Mean cost estimate (USD)")
    path = output_dir / "mean_cost.png"
    save_plot(fig, path)
    return [path.name]


def plot_confusion(confusion: pd.DataFrame, output_dir: Path) -> list[str]:
    if confusion.empty:
        return []
    matrix = confusion.set_index(confusion.columns[0])
    fig, ax = plt.subplots(figsize=(8, 6))
    sns.heatmap(matrix, annot=True, fmt="g", cmap="Blues", ax=ax)
    ax.set_title("Verdict Confusion Matrix")
    ax.set_xlabel("Predicted verdict")
    ax.set_ylabel("Reference verdict")
    path = output_dir / "confusion_matrix.png"
    save_plot(fig, path)
    return [path.name]


def plot_topic_heatmap(topic_summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if topic_summary.empty or "topic" not in topic_summary.columns:
        return []
    matrix = topic_summary.pivot_table(
        index="topic",
        columns="provider",
        values="verdict_accuracy",
        aggfunc="mean",
    )
    if matrix.empty:
        return []
    fig, ax = plt.subplots(figsize=(10, 6))
    sns.heatmap(matrix, annot=True, fmt=".2f", cmap="YlGnBu", vmin=0, vmax=1, ax=ax)
    ax.set_title("Verdict Accuracy By Topic And Provider")
    path = output_dir / "topic_accuracy_heatmap.png"
    save_plot(fig, path)
    return [path.name]


def plot_freshness_heatmap(freshness_summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if freshness_summary.empty or "freshness_bucket" not in freshness_summary.columns:
        return []
    matrix = freshness_summary.pivot_table(
        index="freshness_bucket",
        columns="provider",
        values="verdict_accuracy",
        aggfunc="mean",
    )
    if matrix.empty:
        return []
    fig, ax = plt.subplots(figsize=(10, 6))
    sns.heatmap(matrix, annot=True, fmt=".2f", cmap="magma", vmin=0, vmax=1, ax=ax)
    ax.set_title("Verdict Accuracy By Freshness Bucket And Provider")
    path = output_dir / "freshness_accuracy_heatmap.png"
    save_plot(fig, path)
    return [path.name]


def plot_citation_histogram(details: pd.DataFrame, output_dir: Path) -> list[str]:
    if details.empty or "citation_count" not in details.columns:
        return []
    fig, ax = plt.subplots(figsize=(12, 6))
    sns.histplot(data=details, x="citation_count", hue="provider", multiple="stack", discrete=True, ax=ax)
    ax.set_title("Citation Count Distribution")
    ax.set_xlabel("Citation count")
    path = output_dir / "citation_histogram.png"
    save_plot(fig, path)
    return [path.name]


def plot_ragas(ragas_scores: pd.DataFrame, output_dir: Path) -> list[str]:
    if ragas_scores.empty:
        return []
    score_cols = [column for column in ["context_precision", "faithfulness", "response_relevancy"] if column in ragas_scores.columns]
    if not score_cols:
        return []
    outputs: list[str] = []
    ragas_means = ragas_scores.groupby("provider")[score_cols].mean().reset_index()
    melted = ragas_means.melt(id_vars="provider", var_name="metric", value_name="score")
    fig, ax = plt.subplots(figsize=(12, 6))
    sns.barplot(data=melted, x="provider", y="score", hue="metric", ax=ax)
    ax.set_title("Mean Ragas Metrics By Provider")
    path = output_dir / "ragas_means.png"
    save_plot(fig, path)
    outputs.append(path.name)

    long_df = ragas_scores.melt(
        id_vars=[column for column in ["provider", "provider_mode", "artifact_id"] if column in ragas_scores.columns],
        value_vars=score_cols,
        var_name="metric",
        value_name="score",
    )
    fig, ax = plt.subplots(figsize=(12, 6))
    sns.boxplot(data=long_df, x="metric", y="score", hue="provider", ax=ax)
    ax.set_title("Ragas Metric Spread")
    path = output_dir / "ragas_spread.png"
    save_plot(fig, path)
    outputs.append(path.name)
    return outputs


def write_markdown_report(
    summary: pd.DataFrame,
    details: pd.DataFrame,
    error_summary: pd.DataFrame,
    plot_files: list[str],
    output_path: Path,
) -> None:
    lines = ["# Evaluation Report", ""]
    if not summary.empty:
        best = summary.sort_values(["verdict_accuracy", "success_rate"], ascending=[False, False]).head(5)
        lines.extend(["## Top Provider Modes", "", best.to_markdown(index=False), ""])
        cost_summary = summary[summary["mean_cost_estimate"].fillna(0) > 0].sort_values("mean_cost_estimate")
        if not cost_summary.empty:
            cost_columns = [
                column
                for column in [
                    "provider",
                    "provider_mode",
                    "mean_cost_estimate",
                    "mean_cost_estimate_low",
                    "mean_cost_estimate_high",
                ]
                if column in cost_summary.columns
            ]
            lines.extend(["## Cost Summary", "", cost_summary[cost_columns].to_markdown(index=False), ""])
    if not error_summary.empty:
        lines.extend(["## Error Summary", "", error_summary.head(10).to_markdown(index=False), ""])
    if not details.empty:
        longest = details.sort_values("latency_ms", ascending=False).head(10)[
            ["provider", "provider_mode", "claim_id", "response_verdict", "reference_verdict", "latency_ms", "status"]
        ]
        lines.extend(["## Slowest Runs", "", longest.to_markdown(index=False), ""])
    if plot_files:
        lines.extend(["## Plots", ""])
        for plot_file in plot_files:
            lines.append(f"![{plot_file}](plots/{plot_file})")
            lines.append("")
    output_path.write_text("\n".join(lines))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render evaluation plots and a markdown report.")
    parser.add_argument(
        "--summary-dir",
        default="results/live/summary",
        help="Directory containing evaluator CSV outputs.",
    )
    parser.add_argument(
        "--report-path",
        default="results/live/summary/report.md",
        help="Markdown report output path.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    summary_dir = resolve_path(args.summary_dir)
    report_path = resolve_path(args.report_path)
    plots_dir = report_path.parent / "plots"
    plots_dir.mkdir(parents=True, exist_ok=True)

    sns.set_theme(style="whitegrid", context="talk")

    details = load_csv(summary_dir / "sample_details.csv")
    summary = load_csv(summary_dir / "provider_summary.csv")
    topic_summary = load_csv(summary_dir / "topic_summary.csv")
    freshness_summary = load_csv(summary_dir / "freshness_summary.csv")
    confusion = load_csv(summary_dir / "confusion_matrix.csv")
    error_summary = load_csv(summary_dir / "error_summary.csv")
    ragas_scores = load_csv(summary_dir / "ragas_scores.csv")

    plot_files: list[str] = []
    plot_files.extend(plot_provider_accuracy(summary, plots_dir))
    plot_files.extend(plot_success_vs_latency(summary, plots_dir))
    plot_files.extend(plot_latency_distribution(details, plots_dir))
    plot_files.extend(plot_cost(summary, plots_dir))
    plot_files.extend(plot_confusion(confusion, plots_dir))
    plot_files.extend(plot_topic_heatmap(topic_summary, plots_dir))
    plot_files.extend(plot_freshness_heatmap(freshness_summary, plots_dir))
    plot_files.extend(plot_citation_histogram(details, plots_dir))
    plot_files.extend(plot_ragas(ragas_scores, plots_dir))

    write_markdown_report(summary, details, error_summary, plot_files, report_path)
    print(f"Wrote markdown report to {report_path}")
    print(f"Wrote {len(plot_files)} plot(s) to {plots_dir}")


if __name__ == "__main__":
    main()
