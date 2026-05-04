# Evaluation Workspace

This folder contains the offline evaluation pipeline for the multi-provider fact-checking system.

## Layout

- `datasets/benchmark_claims.jsonl`: starter benchmark dataset with reference verdicts.
- `examples/sample_artifacts.json`: canned sample data for demo/testing only.
- `src/run_benchmark.py`: executes the benchmark claims across provider modes and writes normalized artifacts.
- `src/evaluate_results.py`: loads artifacts, computes summary stats, and optionally runs Ragas.
- `src/render_report.py`: converts summary CSVs into saved plots and a markdown report.
- `notebooks/results_overview.ipynb`: visual report with charts for provider quality, latency, and error analysis.
- `results/`: generated benchmark artifacts, summaries, and plots. This directory is ignored by git.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run A Benchmark

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

To see which provider modes are supported and which keys were detected:

```bash
python3 src/run_benchmark.py --list-provider-modes
```

The benchmark dataset currently contains 20 claims. You can create another JSONL
file with the same fields as `datasets/benchmark_claims.jsonl` and pass it with
`--dataset`.

You can also limit the run while debugging:

```bash
python3 src/run_benchmark.py --max-claims 2 --providers tavily:tavily_research exa:exa_deep_research
```

For a one-claim smoke run across all configured providers:

```bash
python3 src/run_benchmark.py \
  --dataset datasets/benchmark_claims.jsonl \
  --output-file results/live/all_provider_smoke.json \
  --max-claims 1 \
  --judge-provider openai
```

## Provider Modes

Implemented native research-style modes:

- `tavily:tavily_research`: asks Tavily Research to generate the verdict/report directly.
- `exa:exa_search_structured`: asks Exa search with `outputSchema` to generate structured verdict output directly.
- `exa:exa_deep_research`: asks Exa deep-reasoning search to generate structured verdict output directly.
- `parallel:parallel_task_run`: asks Parallel to run the research task and return structured output directly.
- `brave:brave_answers_native`: Brave Answers API, when available for the account.

Implemented retrieval-plus-judge modes:

- `brave:brave_context_plus_judge`: Brave LLM Context returns grounded context/sources, so OpenAI judges the claim from that evidence.
- `firecrawl:firecrawl_search_plus_judge`: Firecrawl returns search/scraped content, so OpenAI judges the claim from that evidence.

Legacy mode:

- `exa:exa_research_async`: Exa `/research/v1`; kept for old artifacts, but Exa docs now point users to `/search` with `type=deep-reasoning`.

Good next candidates for comparable research endpoints:

- OpenAI Responses API with `o3-deep-research` or `o4-mini-deep-research` plus `web_search`.
- Perplexity Sonar/Sonar Pro for cited web-grounded answers.
- Google Gemini with Grounding with Google Search.

For a fair comparison, keep native research agents separate from
retrieval-plus-judge modes in reporting. They have different cost, latency, and
failure surfaces.

## Cost Inputs

The benchmark records provider unit prices directly in each artifact and uses
those fields for cost breakdown charts. Current pricing inputs:

- Tavily: $0.008 per credit.
- Firecrawl Standard: $83/month for 100,000 credits, or $0.00083 per credit.
- Exa Deep Search: $12-$15 per 1,000 requests.
- Parallel: $0.005-$2.40 per request.
- Brave Search: $5 per 1,000 requests.
- Brave Answers: $4 per 1,000 requests plus $5 per million input/output tokens.
- OpenAI GPT-5.5 judge: $5 per million input tokens, $0.50 per million cached input tokens, and $30 per million output tokens.

## Debugging 401s

`401` means the provider rejected the API key for that product. Common causes:

- The key is missing, expired, pasted with quotes/comments, or from a different account.
- The account has a key for search but not for a gated research/answers product.
- The `.env` name does not match what the runner expects.

Expected key names:

- `TAVILY_API_KEY` or `tavily`
- `EXA_API_KEY` or `exa`
- `BRAVE_API_KEY` or `brave`
- `FIRECRAWL_API_KEY` or `firecrawl`
- `PARALLEL_API_KEY` or `parallel`
- `OPENAI_API_KEY` or `openai`
- `ANTHROPIC_API_KEY` or `anthropic`

Run a one-claim smoke test before a full Ragas run:

```bash
python3 src/run_benchmark.py \
  --dataset datasets/benchmark_claims.jsonl \
  --output-file results/live/auth_smoke.json \
  --max-claims 1 \
  --providers tavily:tavily_research exa:exa_deep_research parallel:parallel_task_run \
  --judge-provider openai
```

## Generate Summaries

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

## Render Graphs And A Report

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
- unit pricing and total cost breakdowns
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
