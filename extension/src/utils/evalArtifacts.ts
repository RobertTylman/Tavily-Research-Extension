import { Claim, EvaluationArtifact, Verdict } from '../lib/types';

const ARTIFACTS_KEY = 'evaluationArtifacts';
const MAX_ARTIFACTS = 250;

export async function listEvaluationArtifacts(): Promise<EvaluationArtifact[]> {
  const result = await chrome.storage.local.get(ARTIFACTS_KEY);
  const artifacts = result[ARTIFACTS_KEY];
  return Array.isArray(artifacts) ? (artifacts as EvaluationArtifact[]) : [];
}

export async function logEvaluationArtifact(
  claim: Claim,
  verdict: Verdict,
  status: 'success' | 'error',
  overrides?: Partial<EvaluationArtifact>
): Promise<void> {
  const artifacts = await listEvaluationArtifacts();
  const artifact: EvaluationArtifact = {
    id: `${claim.id}_${Date.now()}`,
    timestamp: new Date().toISOString(),
    claim,
    provider: verdict.provider || overrides?.provider || 'tavily',
    provider_mode: verdict.providerMode || overrides?.provider_mode || 'tavily_research',
    extract_endpoint: overrides?.extract_endpoint,
    research_endpoint: verdict.researchEndpoint || overrides?.research_endpoint,
    retrieved_contexts:
      verdict.retrievedEvidence?.contexts || overrides?.retrieved_contexts || [],
    response: {
      verdict: verdict.verdict,
      explanation: verdict.explanation,
      summary: verdict.summary,
      confidence: verdict.confidence,
      report: verdict.report,
    },
    citations: verdict.citations,
    reference_answer: overrides?.reference_answer,
    reference_verdict: overrides?.reference_verdict,
    latency_ms:
      overrides?.latency_ms ??
      Math.max(0, Math.round((verdict.researchTimeSeconds || 0) * 1000)),
    status,
    error_type: overrides?.error_type,
    cost_estimate: overrides?.cost_estimate ?? null,
  };

  artifacts.unshift(artifact);
  await chrome.storage.local.set({
    [ARTIFACTS_KEY]: artifacts.slice(0, MAX_ARTIFACTS),
  });
}

export async function clearEvaluationArtifacts(): Promise<void> {
  await chrome.storage.local.remove(ARTIFACTS_KEY);
}

export function serializeEvaluationArtifacts(artifacts: EvaluationArtifact[]): string {
  return JSON.stringify(artifacts, null, 2);
}

export function buildEvaluationArtifactsFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `fact-check-eval-artifacts-${stamp}.json`;
}
