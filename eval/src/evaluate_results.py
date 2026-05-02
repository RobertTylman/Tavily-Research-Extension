from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

EVAL_ROOT = Path(__file__).resolve().parent.parent


def load_artifacts(artifacts_dir: Path) -> pd.DataFrame:
    rows: list[dict] = []
    for path in sorted(artifacts_dir.rglob("*.json")):
        if path.name.startswith("."):
            continue
        payload = json.loads(path.read_text())
        if isinstance(payload, list):
            rows.extend(item for item in payload if isinstance(item, dict))
        elif isinstance(payload, dict):
            rows.append(payload)
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def load_benchmark_dataset(dataset_path: Path | None) -> pd.DataFrame:
    if dataset_path is None or not dataset_path.exists():
        return pd.DataFrame()

    rows: list[dict] = []
    with dataset_path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def normalize_artifacts(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    normalized = df.copy()
    normalized["claim"] = normalized.get("claim", pd.Series(index=normalized.index)).apply(
        lambda value: value if isinstance(value, dict) else {}
    )
    normalized["response"] = normalized.get("response", pd.Series(index=normalized.index)).apply(
        lambda value: value if isinstance(value, dict) else {}
    )
    normalized["citations"] = normalized.get("citations", pd.Series(index=normalized.index)).apply(
        lambda value: value if isinstance(value, list) else []
    )
    normalized["retrieved_contexts"] = normalized.get(
        "retrieved_contexts", pd.Series(index=normalized.index)
    ).apply(lambda value: value if isinstance(value, list) else [])

    normalized["claim_id"] = normalized["claim"].apply(lambda value: value.get("id", ""))
    normalized["claim_text"] = normalized["claim"].apply(lambda value: value.get("text", ""))
    normalized["provider"] = normalized.get("provider", pd.Series(index=normalized.index)).fillna(
        "unknown"
    )
    normalized["provider_mode"] = normalized.get(
        "provider_mode", pd.Series(index=normalized.index)
    ).fillna("unknown")
    normalized["status"] = normalized.get("status", pd.Series(index=normalized.index)).fillna(
        "success"
    )
    normalized["latency_ms"] = pd.to_numeric(
        normalized.get("latency_ms", pd.Series(index=normalized.index)), errors="coerce"
    ).fillna(0)
    normalized["cost_estimate"] = pd.to_numeric(
        normalized.get("cost_estimate", pd.Series(index=normalized.index)), errors="coerce"
    ).fillna(0)
    normalized["cost_estimate_low"] = pd.to_numeric(
        normalized.get("cost_estimate_low", normalized.get("cost_estimate", pd.Series(index=normalized.index))),
        errors="coerce",
    ).fillna(normalized["cost_estimate"])
    normalized["cost_estimate_high"] = pd.to_numeric(
        normalized.get("cost_estimate_high", normalized.get("cost_estimate", pd.Series(index=normalized.index))),
        errors="coerce",
    ).fillna(normalized["cost_estimate"])
    normalized["cost_estimate_method"] = normalized.get(
        "cost_estimate_method", pd.Series(index=normalized.index)
    ).fillna("")
    normalized["citation_count"] = normalized["citations"].apply(len)
    normalized["source_count"] = normalized["citations"].apply(
        lambda items: len({item.get("url", "") for item in items if isinstance(item, dict)})
    )
    normalized["response_verdict"] = normalized["response"].apply(lambda value: value.get("verdict"))
    normalized["response_summary"] = normalized["response"].apply(
        lambda value: value.get("summary") or value.get("explanation", "")
    )
    normalized["response_explanation"] = normalized["response"].apply(
        lambda value: value.get("explanation", "")
    )
    normalized["response_text"] = normalized["response"].apply(
        lambda value: "\n\n".join(
            filter(
                None,
                [
                    value.get("summary", ""),
                    value.get("explanation", ""),
                    value.get("report", ""),
                ],
            )
        )
    )
    normalized["response_confidence"] = normalized["response"].apply(
        lambda value: value.get("confidence")
    )
    normalized["reference_answer"] = normalized.get(
        "reference_answer", pd.Series(index=normalized.index)
    ).fillna("")
    normalized["reference_verdict"] = normalized.get(
        "reference_verdict", pd.Series(index=normalized.index)
    ).fillna("")
    normalized["error_type"] = normalized.get("error_type", pd.Series(index=normalized.index)).fillna(
        ""
    )
    normalized["timestamp"] = pd.to_datetime(
        normalized.get("timestamp", pd.Series(index=normalized.index)), errors="coerce", utc=True
    )
    return normalized


def merge_benchmark_metadata(df: pd.DataFrame, benchmark_df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or benchmark_df.empty:
        return df

    benchmark = benchmark_df.rename(
        columns={
            "id": "claim_id",
            "claim": "benchmark_claim",
            "reference_answer": "benchmark_reference_answer",
            "reference_verdict": "benchmark_reference_verdict",
        }
    )
    merged = df.merge(benchmark, on="claim_id", how="left")

    if "benchmark_reference_answer" in merged.columns:
        merged["reference_answer"] = merged["reference_answer"].where(
            merged["reference_answer"].astype(str).str.len() > 0,
            merged["benchmark_reference_answer"].fillna(""),
        )
    if "benchmark_reference_verdict" in merged.columns:
        merged["reference_verdict"] = merged["reference_verdict"].where(
            merged["reference_verdict"].astype(str).str.len() > 0,
            merged["benchmark_reference_verdict"].fillna(""),
        )
    if "benchmark_claim" in merged.columns:
        merged["claim_text"] = merged["claim_text"].where(
            merged["claim_text"].astype(str).str.len() > 0,
            merged["benchmark_claim"].fillna(""),
        )
    return merged


def filter_latest_runs(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "timestamp" not in df.columns:
        return df

    sortable = df.copy()
    sortable["_timestamp_sort"] = sortable["timestamp"].fillna(pd.Timestamp.min.tz_localize("UTC"))
    latest = (
        sortable.sort_values("_timestamp_sort")
        .drop_duplicates(subset=["claim_id", "provider", "provider_mode"], keep="last")
        .drop(columns="_timestamp_sort")
    )
    return latest.reset_index(drop=True)


def provider_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()

    summary = (
        df.groupby(["provider", "provider_mode"], dropna=False)
        .agg(
            runs=("id", "count"),
            success_rate=("status", lambda values: (values == "success").mean()),
            mean_latency_ms=("latency_ms", "mean"),
            median_latency_ms=("latency_ms", "median"),
            mean_citations=("citation_count", "mean"),
            mean_sources=("source_count", "mean"),
            mean_cost_estimate=("cost_estimate", "mean"),
            mean_cost_estimate_low=("cost_estimate_low", "mean"),
            mean_cost_estimate_high=("cost_estimate_high", "mean"),
            verdict_accuracy=(
                "response_verdict",
                lambda values: (
                    values.reset_index(drop=True)
                    == df.loc[values.index, "reference_verdict"].reset_index(drop=True)
                ).mean()
                if len(values) > 0
                else 0,
            ),
        )
        .reset_index()
    )
    return summary.sort_values(["provider", "provider_mode"]).reset_index(drop=True)


def dimension_summary(df: pd.DataFrame, dimension: str) -> pd.DataFrame:
    if df.empty or dimension not in df.columns:
        return pd.DataFrame()

    scoped = df[df[dimension].fillna("").astype(str).str.len() > 0].copy()
    if scoped.empty:
        return pd.DataFrame()

    summary = (
        scoped.groupby(["provider", "provider_mode", dimension], dropna=False)
        .agg(
            runs=("id", "count"),
            success_rate=("status", lambda values: (values == "success").mean()),
            mean_latency_ms=("latency_ms", "mean"),
            mean_cost_estimate=("cost_estimate", "mean"),
            mean_cost_estimate_low=("cost_estimate_low", "mean"),
            mean_cost_estimate_high=("cost_estimate_high", "mean"),
            verdict_accuracy=(
                "response_verdict",
                lambda values: (
                    values.reset_index(drop=True)
                    == scoped.loc[values.index, "reference_verdict"].reset_index(drop=True)
                ).mean()
                if len(values) > 0
                else 0,
            ),
        )
        .reset_index()
    )
    return summary.sort_values(["provider", "provider_mode", dimension]).reset_index(drop=True)


def error_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()

    errors = df[df["status"] != "success"].copy()
    if errors.empty:
        return pd.DataFrame()

    summary = (
        errors.groupby(["provider", "provider_mode", "error_type"], dropna=False)
        .agg(
            failures=("id", "count"),
            mean_latency_ms=("latency_ms", "mean"),
        )
        .reset_index()
    )
    return summary.sort_values(["failures", "provider"], ascending=[False, True]).reset_index(
        drop=True
    )


def build_confusion_matrix(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    return pd.crosstab(df["reference_verdict"], df["response_verdict"]).reset_index()


def build_ragas_frame(df: pd.DataFrame) -> pd.DataFrame:
    ragas_rows = []
    for _, row in df.iterrows():
        if row["status"] != "success":
            continue
        ragas_rows.append(
            {
                "question": row["claim_text"],
                "answer": row["response_text"],
                "contexts": row["retrieved_contexts"]
                or [citation.get("snippet", "") for citation in row["citations"]],
                "reference": row["reference_answer"],
                "provider": row["provider"],
                "provider_mode": row["provider_mode"],
                "artifact_id": row["id"],
            }
        )
    return pd.DataFrame(ragas_rows)


def run_ragas(df: pd.DataFrame) -> pd.DataFrame:
    ragas_df = build_ragas_frame(df)
    if ragas_df.empty:
        return pd.DataFrame()

    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import context_precision, faithfulness, response_relevancy
    except ImportError as exc:
        raise RuntimeError(
            "Ragas or datasets is not installed. Run `pip install -r eval/requirements.txt` first."
        ) from exc

    dataset = Dataset.from_pandas(ragas_df[["question", "answer", "contexts", "reference"]])
    result = evaluate(
        dataset=dataset,
        metrics=[context_precision, faithfulness, response_relevancy],
    )

    if hasattr(result, "to_pandas"):
        scored = result.to_pandas()
    else:
        scored = pd.DataFrame(result)

    scored["provider"] = ragas_df["provider"].values
    scored["provider_mode"] = ragas_df["provider_mode"].values
    scored["artifact_id"] = ragas_df["artifact_id"].values
    return scored


def save_outputs(
    normalized: pd.DataFrame,
    summary: pd.DataFrame,
    topic_summary_df: pd.DataFrame,
    freshness_summary_df: pd.DataFrame,
    confusion_matrix_df: pd.DataFrame,
    error_summary_df: pd.DataFrame,
    ragas_scores: pd.DataFrame,
    output_dir: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    normalized.to_csv(output_dir / "sample_details.csv", index=False)
    summary.to_csv(output_dir / "provider_summary.csv", index=False)
    if not topic_summary_df.empty:
        topic_summary_df.to_csv(output_dir / "topic_summary.csv", index=False)
    if not freshness_summary_df.empty:
        freshness_summary_df.to_csv(output_dir / "freshness_summary.csv", index=False)
    if not confusion_matrix_df.empty:
        confusion_matrix_df.to_csv(output_dir / "confusion_matrix.csv", index=False)
    if not error_summary_df.empty:
        error_summary_df.to_csv(output_dir / "error_summary.csv", index=False)
    if not ragas_scores.empty:
        ragas_scores.to_csv(output_dir / "ragas_scores.csv", index=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate normalized fact-check artifacts.")
    parser.add_argument(
        "--artifacts-dir",
        default="results/live",
        help="Directory containing JSON artifacts.",
    )
    parser.add_argument(
        "--output-dir",
        default="results/live/summary",
        help="Directory where CSV summaries should be written.",
    )
    parser.add_argument(
        "--benchmark-dataset",
        default="datasets/benchmark_claims.jsonl",
        help="Optional JSONL benchmark dataset used to fill reference metadata and slice results.",
    )
    parser.add_argument(
        "--latest-per-claim-provider",
        action="store_true",
        help="Keep only the latest artifact for each claim/provider/provider_mode combination.",
    )
    parser.add_argument(
        "--run-ragas",
        action="store_true",
        help="Run Ragas metrics over successful artifacts.",
    )
    return parser.parse_args()


def resolve_eval_path(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    candidate = Path(path_value)
    if candidate.is_absolute():
        return candidate
    if candidate.exists():
        return candidate
    cwd_candidate = Path.cwd() / candidate
    if cwd_candidate.parent.exists():
        return cwd_candidate
    return EVAL_ROOT / candidate


def main() -> None:
    args = parse_args()
    artifacts_dir = resolve_eval_path(args.artifacts_dir) or EVAL_ROOT / "results"
    output_dir = resolve_eval_path(args.output_dir) or EVAL_ROOT / "results" / "summary"
    benchmark_path = resolve_eval_path(args.benchmark_dataset)

    raw = load_artifacts(artifacts_dir)
    normalized = normalize_artifacts(raw)
    benchmark_df = load_benchmark_dataset(benchmark_path)
    normalized = merge_benchmark_metadata(normalized, benchmark_df)
    if args.latest_per_claim_provider and not normalized.empty:
        normalized = filter_latest_runs(normalized)

    summary = provider_summary(normalized)
    topic_summary_df = dimension_summary(normalized, "topic")
    freshness_summary_df = dimension_summary(normalized, "freshness_bucket")
    confusion_matrix_df = build_confusion_matrix(normalized)
    error_summary_df = error_summary(normalized)
    ragas_scores = run_ragas(normalized) if args.run_ragas and not normalized.empty else pd.DataFrame()

    save_outputs(
        normalized,
        summary,
        topic_summary_df,
        freshness_summary_df,
        confusion_matrix_df,
        error_summary_df,
        ragas_scores,
        output_dir,
    )

    if normalized.empty:
        print(f"No artifacts found in {artifacts_dir}")
        return

    print(f"Loaded {len(normalized)} artifacts from {artifacts_dir}")
    if not benchmark_df.empty:
        print(f"Merged benchmark metadata from {benchmark_path}")
    print(f"Wrote summaries to {output_dir}")
    if not topic_summary_df.empty:
        print(f"Wrote topic breakdown to {output_dir / 'topic_summary.csv'}")
    if not freshness_summary_df.empty:
        print(f"Wrote freshness breakdown to {output_dir / 'freshness_summary.csv'}")
    if not confusion_matrix_df.empty:
        print(f"Wrote confusion matrix to {output_dir / 'confusion_matrix.csv'}")
    if not error_summary_df.empty:
        print(f"Wrote error summary to {output_dir / 'error_summary.csv'}")
    if not ragas_scores.empty:
        print(f"Wrote {len(ragas_scores)} scored rows to {output_dir / 'ragas_scores.csv'}")


if __name__ == "__main__":
    main()
