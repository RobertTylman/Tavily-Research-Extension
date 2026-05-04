from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", tempfile.mkdtemp(prefix="matplotlib-"))

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MaxNLocator
import pandas as pd
import seaborn as sns

EVAL_ROOT = Path(__file__).resolve().parent.parent
PROVIDER_PALETTE = "Set2"


def provider_mode_label(row: pd.Series) -> str:
    provider = str(row.get("provider", "")).strip()
    mode = str(row.get("provider_mode", "")).strip().replace("_", " ")
    return f"{provider} - {mode}"


def add_value_labels(ax: plt.Axes, unit: str = "", precision: int = 1) -> None:
    for container in ax.containers:
        if not hasattr(container, "datavalues"):
            continue
        labels = []
        for value in container.datavalues:
            if pd.isna(value):
                labels.append("")
            elif unit == "percent":
                labels.append(f"{value:.0%}")
            elif unit == "cents":
                labels.append(f"{value:.{precision}f}¢")
            elif unit == "seconds":
                labels.append(f"{value:.{precision}f}s")
            else:
                labels.append(f"{value:.{precision}f}")
        ax.bar_label(container, labels=labels, padding=4, fontsize=9)


def style_axis(ax: plt.Axes) -> None:
    ax.grid(axis="x", color="#d9dee7", linewidth=0.8, alpha=0.8)
    ax.grid(axis="y", visible=False)
    sns.despine(ax=ax, left=True, bottom=False)


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
    fig, ax = plt.subplots(figsize=(12, max(5, len(summary) * 0.55)))
    chart_df = summary.sort_values(["verdict_accuracy", "success_rate"], ascending=[False, False]).copy()
    chart_df["label"] = chart_df.apply(provider_mode_label, axis=1)
    sns.barplot(
        data=chart_df,
        x="verdict_accuracy",
        y="label",
        hue="provider",
        palette=PROVIDER_PALETTE,
        ax=ax,
    )
    ax.set_title("Verdict Accuracy By Provider Mode")
    ax.set_xlabel("Accuracy")
    ax.set_ylabel("")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:.0%}"))
    ax.set_xlim(0, max(1.0, chart_df["verdict_accuracy"].max() * 1.08))
    add_value_labels(ax, unit="percent", precision=0)
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    style_axis(ax)
    path = output_dir / "provider_accuracy.png"
    save_plot(fig, path)
    return [path.name]


def plot_success_vs_latency(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty:
        return []
    fig, ax = plt.subplots(figsize=(13, 7))
    scatter = summary.copy()
    scatter["mean_latency_s"] = scatter["mean_latency_ms"] / 1000
    scatter["label"] = scatter.apply(provider_mode_label, axis=1)
    sns.scatterplot(
        data=scatter,
        x="mean_latency_s",
        y="success_rate",
        hue="provider",
        palette=PROVIDER_PALETTE,
        s=130,
        ax=ax,
    )
    scatter = scatter.sort_values("mean_latency_s").reset_index(drop=True)
    label_offsets = [(7, 10), (7, -14), (7, 24), (7, -28)]
    for index, row in scatter.iterrows():
        offset = label_offsets[index % len(label_offsets)]
        ax.annotate(
            str(row["provider"]),
            (row["mean_latency_s"], row["success_rate"]),
            xytext=offset,
            textcoords="offset points",
            fontsize=9,
            color="#30343b",
            arrowprops={"arrowstyle": "-", "color": "#a8b0bd", "linewidth": 0.8},
        )
    ax.set_title("Success Rate vs Mean Latency")
    ax.set_xlabel("Mean latency (seconds)")
    ax.set_ylabel("Success rate")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:.0%}"))
    if scatter["success_rate"].min() >= 0.8:
        ax.set_ylim(0.88, 1.0)
    else:
        ax.set_ylim(0, 1.0)
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", borderaxespad=0.0, frameon=False)
    style_axis(ax)
    path = output_dir / "success_vs_latency.png"
    save_plot(fig, path)
    return [path.name]


def plot_latency_distribution(details: pd.DataFrame, output_dir: Path) -> list[str]:
    if details.empty:
        return []
    latency = details.copy()
    latency["latency_s"] = latency["latency_ms"] / 1000
    latency["label"] = latency.apply(provider_mode_label, axis=1)
    latency = latency.sort_values("latency_s", ascending=True)
    fig, ax = plt.subplots(figsize=(12, max(5, len(latency) * 0.55)))
    sns.scatterplot(
        data=latency,
        x="latency_s",
        y="label",
        hue="provider",
        palette=PROVIDER_PALETTE,
        s=140,
        ax=ax,
    )
    for _, row in latency.iterrows():
        ax.hlines(row["label"], xmin=0, xmax=row["latency_s"], color="#c7cedb", linewidth=2, zorder=0)
        ax.annotate(
            f"{row['latency_s']:.1f}s",
            (row["latency_s"], row["label"]),
            xytext=(8, 0),
            textcoords="offset points",
            va="center",
            fontsize=9,
        )
    ax.set_title("Latency By Provider Mode")
    ax.set_xlabel("Latency (seconds)")
    ax.set_ylabel("")
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    style_axis(ax)
    path = output_dir / "latency_distribution.png"
    save_plot(fig, path)
    return [path.name]


def plot_cost(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty or "mean_cost_estimate" not in summary.columns:
        return []
    cost_df = summary[summary["mean_cost_estimate"].fillna(0) > 0].copy()
    if cost_df.empty:
        return []
    
    # Convert to cents
    for col in ["mean_cost_estimate", "mean_cost_estimate_low", "mean_cost_estimate_high"]:
        if col in cost_df.columns:
            cost_df[col] = cost_df[col] * 100

    cost_df["label"] = cost_df.apply(provider_mode_label, axis=1)
    cost_df = cost_df.sort_values("mean_cost_estimate", ascending=True)
    fig, ax = plt.subplots(figsize=(12, max(5, len(cost_df) * 0.55)))
    sns.barplot(
        data=cost_df,
        x="mean_cost_estimate",
        y="label",
        hue="provider",
        palette=PROVIDER_PALETTE,
        ax=ax,
    )
    if {
        "mean_cost_estimate_low",
        "mean_cost_estimate_high",
    }.issubset(cost_df.columns):
        y_positions = ax.get_yticks()
        lower_errors = (cost_df["mean_cost_estimate"] - cost_df["mean_cost_estimate_low"]).clip(lower=0)
        upper_errors = (cost_df["mean_cost_estimate_high"] - cost_df["mean_cost_estimate"]).clip(lower=0)
        ax.errorbar(
            cost_df["mean_cost_estimate"],
            y_positions,
            xerr=[lower_errors.to_numpy(), upper_errors.to_numpy()],
            fmt="none",
            ecolor="black",
            elinewidth=1,
            capsize=4,
        )
    ax.set_title("Mean Cost Per Run By Provider Mode")
    ax.set_xlabel("Mean cost per run (¢ USD)")
    ax.set_ylabel("")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:g}¢"))
    add_value_labels(ax, unit="cents", precision=2)
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    style_axis(ax)
    path = output_dir / "mean_cost.png"
    save_plot(fig, path)
    return [path.name]


def plot_unit_price(summary: pd.DataFrame, output_dir: Path) -> list[str]:
    if summary.empty or "mean_cost_unit_price" not in summary.columns:
        return []
    price_df = summary[summary["mean_cost_unit_price"].fillna(0) > 0].copy()
    if price_df.empty:
        return []
    
    # Convert to cents
    for col in ["mean_cost_unit_price", "mean_cost_unit_price_low", "mean_cost_unit_price_high"]:
        if col in price_df.columns:
            price_df[col] = price_df[col] * 100

    price_df["label"] = price_df.apply(provider_mode_label, axis=1)
    price_df = price_df.sort_values("mean_cost_unit_price", ascending=True)
    fig, ax = plt.subplots(figsize=(12, max(5, len(price_df) * 0.55)))
    sns.barplot(
        data=price_df,
        x="mean_cost_unit_price",
        y="label",
        hue="provider",
        palette=PROVIDER_PALETTE,
        ax=ax,
    )
    if {
        "mean_cost_unit_price_low",
        "mean_cost_unit_price_high",
    }.issubset(price_df.columns):
        y_positions = ax.get_yticks()
        lower_errors = (price_df["mean_cost_unit_price"] - price_df["mean_cost_unit_price_low"]).clip(lower=0)
        upper_errors = (price_df["mean_cost_unit_price_high"] - price_df["mean_cost_unit_price"]).clip(lower=0)
        ax.errorbar(
            price_df["mean_cost_unit_price"],
            y_positions,
            xerr=[lower_errors.to_numpy(), upper_errors.to_numpy()],
            fmt="none",
            ecolor="black",
            elinewidth=1,
            capsize=4,
        )
    ax.set_title("Unit Price By Provider Mode")
    ax.set_xlabel("Unit price (¢ USD)")
    ax.set_ylabel("")
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:g}¢"))
    if price_df["mean_cost_unit_price"].max() / max(price_df["mean_cost_unit_price"].min(), 1e-9) > 100:
        ax.set_xscale("log")
        ax.set_xlabel("Unit price (¢ USD, log scale)")
        left, right = ax.get_xlim()
        ax.set_xlim(left, right * 1.8)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:g}¢"))
    add_value_labels(ax, unit="cents", precision=3)
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    style_axis(ax)
    path = output_dir / "unit_price.png"
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
    citation_df = details.copy()
    citation_df["citation_count"] = pd.to_numeric(citation_df["citation_count"], errors="coerce").fillna(0).astype(int)
    counts = (
        citation_df.groupby(["citation_count", "provider"], dropna=False)
        .size()
        .reset_index(name="runs")
    )
    fig, ax = plt.subplots(figsize=(11, 6))
    sns.barplot(
        data=counts,
        x="citation_count",
        y="runs",
        hue="provider",
        palette=PROVIDER_PALETTE,
        ax=ax,
    )
    ax.set_title("Citation Count Distribution")
    ax.set_xlabel("Citations returned per run")
    ax.set_ylabel("Number of runs")
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    style_axis(ax)
    path = output_dir / "citation_histogram.png"
    save_plot(fig, path)
    return [path.name]


def plot_ragas(ragas_scores: pd.DataFrame, output_dir: Path) -> list[str]:
    if ragas_scores.empty:
        return []
    score_cols = [
        column
        for column in ["context_precision", "faithfulness", "answer_relevancy", "response_relevancy"]
        if column in ragas_scores.columns
    ]
    if not score_cols:
        return []
    outputs: list[str] = []
    scored = ragas_scores.copy()
    scored["label"] = scored.apply(provider_mode_label, axis=1)
    ragas_means = scored.groupby(["provider", "provider_mode", "label"], dropna=False)[score_cols].mean().reset_index()
    melted = ragas_means.melt(
        id_vars=["provider", "provider_mode", "label"],
        var_name="metric",
        value_name="score",
    ).dropna(subset=["score"])
    if melted.empty:
        return []
    heatmap = ragas_means.set_index("label")[score_cols]
    fig, ax = plt.subplots(figsize=(10, max(5, ragas_means.shape[0] * 0.55)))
    sns.heatmap(
        heatmap,
        annot=True,
        fmt=".2f",
        cmap="YlGnBu",
        vmin=0,
        vmax=1,
        linewidths=0.8,
        linecolor="white",
        cbar_kws={"label": "Score"},
        ax=ax,
    )
    ax.set_title("Mean Ragas Metrics By Provider Mode")
    ax.set_xlabel("")
    ax.set_ylabel("")
    path = output_dir / "ragas_means.png"
    save_plot(fig, path)
    outputs.append(path.name)

    long_df = scored.melt(
        id_vars=[column for column in ["provider", "provider_mode", "label", "artifact_id"] if column in scored.columns],
        value_vars=score_cols,
        var_name="metric",
        value_name="score",
    ).dropna(subset=["score"])
    fig, ax = plt.subplots(figsize=(12, 6))
    sns.stripplot(
        data=long_df,
        x="metric",
        y="score",
        hue="provider",
        dodge=True,
        palette=PROVIDER_PALETTE,
        size=8,
        alpha=0.85,
        ax=ax,
    )
    ax.set_title("Ragas Metric Spread")
    ax.set_xlabel("")
    ax.set_ylabel("Score")
    ax.set_ylim(0, 1)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:.0%}"))
    ax.legend(title="Provider", bbox_to_anchor=(1.02, 1), loc="upper left", frameon=False)
    sns.despine(ax=ax)
    path = output_dir / "ragas_spread.png"
    save_plot(fig, path)
    outputs.append(path.name)
    return outputs


def write_markdown_report(
    summary: pd.DataFrame,
    details: pd.DataFrame,
    error_summary: pd.DataFrame,
    ragas_scores: pd.DataFrame,
    plot_files: list[str],
    output_path: Path,
) -> None:
    lines = ["# Evaluation Report", ""]
    if not summary.empty:
        best = summary.sort_values(["verdict_accuracy", "success_rate"], ascending=[False, False]).head(5)
        lines.extend(["## Top Provider Modes", "", best.to_markdown(index=False), ""])
        cost_summary = summary[summary["mean_cost_estimate"].fillna(0) > 0].sort_values("mean_cost_estimate").copy()
        if not cost_summary.empty:
            for source, target in [
                ("mean_cost_unit_price", "mean_unit_price_cents_usd"),
                ("mean_cost_unit_price_low", "mean_unit_price_low_cents_usd"),
                ("mean_cost_unit_price_high", "mean_unit_price_high_cents_usd"),
                ("mean_cost_estimate", "mean_cost_cents_usd"),
                ("mean_cost_estimate_low", "mean_cost_low_cents_usd"),
                ("mean_cost_estimate_high", "mean_cost_high_cents_usd"),
            ]:
                if source in cost_summary.columns:
                    cost_summary[target] = cost_summary[source] * 100
            cost_columns = [
                column
                for column in [
                    "provider",
                    "provider_mode",
                    "mean_cost_units",
                    "cost_unit_name",
                    "mean_unit_price_cents_usd",
                    "mean_unit_price_low_cents_usd",
                    "mean_unit_price_high_cents_usd",
                    "mean_cost_cents_usd",
                    "mean_cost_low_cents_usd",
                    "mean_cost_high_cents_usd",
                ]
                if column in cost_summary.columns
            ]
            lines.extend(["## Cost Summary", "", cost_summary[cost_columns].to_markdown(index=False), ""])
    if not ragas_scores.empty:
        score_cols = [
            column
            for column in ["context_precision", "faithfulness", "answer_relevancy", "response_relevancy"]
            if column in ragas_scores.columns
        ]
        if score_cols:
            coverage = (
                ragas_scores.groupby(["provider", "provider_mode"], dropna=False)[score_cols]
                .agg(lambda values: values.notna().sum())
                .reset_index()
            )
            lines.extend(
                [
                    "## Ragas Coverage",
                    "",
                    "Ragas charts include only rows in `ragas_scores.csv`. Missing bars usually mean the metric column was not produced by the installed Ragas version or the score was `NaN` for that provider response.",
                    "",
                    coverage.to_markdown(index=False),
                    "",
                ]
            )
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
    
    if not details.empty:
        lines.extend(["## Detailed Model Responses", ""])
        # Group by provider and mode to make it readable
        for (provider, mode), group in details.groupby(["provider", "provider_mode"]):
            lines.extend([f"### {provider} - {mode}", ""])
            for _, row in group.iterrows():
                claim_text = row.get("claim_text") or "N/A"
                verdict = row.get("response_verdict") or "N/A"
                confidence = row.get("response_confidence") or "N/A"
                response_text = row.get("response_text") or "No text generated."
                
                lines.append(f"**Claim:** {claim_text}")
                lines.append(f"**Verdict:** {verdict} (Confidence: {confidence})")
                lines.append("")
                lines.append("**Full Response:**")
                lines.append("---")
                lines.append(response_text)
                lines.append("---")
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

    sns.set_theme(style="whitegrid", context="notebook", font_scale=1.05)

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
    plot_files.extend(plot_unit_price(summary, plots_dir))
    plot_files.extend(plot_confusion(confusion, plots_dir))
    plot_files.extend(plot_topic_heatmap(topic_summary, plots_dir))
    plot_files.extend(plot_freshness_heatmap(freshness_summary, plots_dir))
    plot_files.extend(plot_citation_histogram(details, plots_dir))
    plot_files.extend(plot_ragas(ragas_scores, plots_dir))

    write_markdown_report(summary, details, error_summary, ragas_scores, plot_files, report_path)
    print(f"Wrote markdown report to {report_path}")
    print(f"Wrote {len(plot_files)} plot(s) to {plots_dir}")


if __name__ == "__main__":
    main()
