# Evaluation Workspace

This folder contains the offline evaluation pipeline for the multi-provider fact-checking system.

## What lives here

- `datasets/benchmark_claims.jsonl`: starter benchmark dataset with reference verdicts.
- `results/live/`: real benchmark artifacts and generated summary tables.
- `examples/sample_artifacts.json`: canned sample data for demo/testing only.
- `src/run_benchmark.py`: executes the benchmark claims across provider modes and writes normalized artifacts.
- `src/evaluate_results.py`: loads artifacts, computes summary stats, and optionally runs Ragas.
- `src/render_report.py`: converts summary CSVs into saved plots and a markdown report.
- `notebooks/results_overview.ipynb`: visual report with charts for provider quality, latency, and error analysis.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Generate summaries

```bash
python3 src/evaluate_results.py --artifacts-dir results/live --output-dir results/live/summary
```

To compare repeated provider runs cleanly, keep only the latest artifact per
`claim_id + provider + provider_mode`:

```bash
python3 src/evaluate_results.py --artifacts-dir results/live --output-dir results/live/summary --latest-per-claim-provider
```

The evaluator automatically loads `datasets/benchmark_claims.jsonl` by default
to fill in missing benchmark metadata and produce sliced reports such as:

- `provider_summary.csv`
- `topic_summary.csv`
- `freshness_summary.csv`
- `confusion_matrix.csv`
- `error_summary.csv`

## Run Ragas scoring

Ragas uses OpenAI for both the evaluation LLM and embeddings backend. Set
`OPENAI_API_KEY` in your shell or in the repo root `.env` as `OPENAI_API_KEY=...`
or `openai: ...`.

```bash
python3 src/evaluate_results.py \
  --artifacts-dir results/live \
  --output-dir results/live/summary \
  --latest-per-claim-provider \
  --run-ragas
```

By default this uses `gpt-4o-mini` and `text-embedding-3-small`. Override them
with `--ragas-llm-model` and `--ragas-embedding-model` if needed.

## Run the benchmark across APIs

Set the API keys you want to evaluate in your environment. The runner
automatically skips provider modes whose required keys are missing.

```bash
export TAVILY_API_KEY=...
export EXA_API_KEY=...
export BRAVE_API_KEY=...
export FIRECRAWL_API_KEY=...
export PARALLEL_API_KEY=...
export OPENAI_API_KEY=...

python3 src/run_benchmark.py \
  --dataset datasets/benchmark_claims.jsonl \
  --output-file results/live/benchmark_run.json \
  --judge-provider openai
```

The starter dataset currently contains 5 claims. For a 10-prompt run, create a
JSONL file with 10 rows using the same fields as `datasets/benchmark_claims.jsonl`
and pass it with `--dataset`.

You can also limit the run while debugging:

```bash
python3 src/run_benchmark.py --max-claims 2 --providers tavily:tavily_research exa:exa_search_structured
```

For a one-claim smoke run across all configured providers:

```bash
python3 src/run_benchmark.py \
  --dataset datasets/benchmark_claims.jsonl \
  --output-file results/live/all_provider_smoke.json \
  --max-claims 1 \
  --judge-provider openai
```

## Render graphs and a report

After generating summary CSVs, render a markdown report and plot images:

```bash
python3 src/render_report.py --summary-dir results/live/summary --report-path results/live/summary/report.md
```

This writes PNG charts under `results/live/summary/plots/`, including:

- provider accuracy bars
- success-rate vs latency scatter
- latency distribution boxplots
- confusion matrix heatmap
- topic and freshness accuracy heatmaps
- citation count histogram
- optional Ragas charts when `ragas_scores.csv` exists

## Notebook

Open `notebooks/results_overview.ipynb` after generating the summary files. The notebook reads the raw live artifacts from `results/live/`, merges any scored outputs, and renders:

- provider coverage and failure rate
- latency distributions
- cost estimates
- mean Ragas metric bars
- metric spread boxplots
- verdict confusion heatmap
- latency vs faithfulness scatter
- citation count histogram

To execute the notebook from the CLI after either a smoke run or a full run:

```bash
source .venv/bin/activate
jupyter nbconvert --to notebook --execute --ExecutePreprocessor.kernel_name=python3 notebooks/results_overview.ipynb --output results_overview.executed.ipynb
```

The notebook currently reads every JSON artifact under `results/live/`, so run it
after writing the artifacts you want included in the graphs.

## Export artifacts from the extension

The extension settings panel now includes an **Evaluation Artifacts** section.
Use **Export artifacts** to download the current `chrome.storage.local`
evaluation log as JSON, then place that file under `eval/results/live/` before
running the evaluator. You can then render the saved graphs with
`src/render_report.py`.

# Run Evaluation:

```
cd eval
source .venv/bin/activate
pip install -r requirements.txt

export TAVILY_API_KEY=...
export EXA_API_KEY=...
export BRAVE_API_KEY=...
export FIRECRAWL_API_KEY=...
export PARALLEL_API_KEY=...
export OPENAI_API_KEY=...

python3 src/run_benchmark.py 
--dataset /Users/robbietylman/Documents/GitHub/Fact-Checker/eval/datasets/benchmark_claims.jsonl \
--output-file results/live/10_prompt_all_api.json 
--providers 
tavily:tavily_research 
exa:exa_search_structured 
exa:exa_research_async 
brave:brave_context_plus_judge 
firecrawl:firecrawl_search_plus_judge 
parallel:parallel_task_run 
--judge-provider openai 
--sleep-seconds 1

python3 src/evaluate_results.py 
--artifacts-dir results/live 
--output-dir results/live/summary 
--benchmark-dataset /Users/robbietylman/Documents/GitHub/Fact-Checker/eval/datasets/benchmark_claims.jsonl 
--latest-per-claim-provider 
--run-ragas

python3 src/render_report.py 
--summary-dir results/live/summary 
--report-path results/live/summary/report.md
```