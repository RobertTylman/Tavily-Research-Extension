/**
 * Core type definitions for the Fact-Checking Extension
 *
 * These types define the data structures used throughout the verification pipeline:
 * Text → Claims → Tavily Research → Verdicts
 */

// ============================================================================
// CLAIM TYPES
// ============================================================================

/**
 * The text the user submitted for fact-checking. Sent verbatim to Tavily.
 */
export interface Claim {
  /** Unique identifier for tracking through the pipeline */
  id: string;
  /** Claim text sent to the research agent */
  text: string;
  /** Original text the user submitted (kept for UI display) */
  originalText: string;
}

// ============================================================================
// VERDICT TYPES
// ============================================================================

/**
 * Final verdict label for a verified claim
 * - SUPPORTED: Strong evidence confirms the claim
 * - FALSE: Strong evidence contradicts the claim
 * - MISLEADING: Claim contains some truth but is deceptive overall
 * - INSUFFICIENT_EVIDENCE: Not enough reliable sources to determine
 */
export type VerdictLabel = 'SUPPORTED' | 'FALSE' | 'MISLEADING' | 'INSUFFICIENT_EVIDENCE';

/**
 * A citation for a verdict
 */
export interface Citation {
  /** Optional article headline */
  title?: string;
  /** Source name */
  source: string;
  /** Direct URL to the source */
  url: string;
  /** Relevant quote from the source */
  snippet: string;
  /** Publication date, if available */
  publishedDate?: string | null;
  /** Authority score carried through for transparency */
  authority?: number;
  /** Optional stance kept for backwards compatibility with UI widgets */
  stance?: 'SUPPORTS' | 'CONTRADICTS' | 'INCONCLUSIVE';
  /** Short rationale provided by the research agent, if any */
  reasoning?: string;
  /** Which component produced this citation (always "tavily_research" today) */
  entailmentProvider?: string;
  /** Source favicon URL returned by the research endpoint */
  favicon?: string;
}

/**
 * Final verdict for a claim after verification
 */
export interface Verdict {
  /** ID of the claim this verdict applies to */
  claimId: string;
  /** The verdict label */
  verdict: VerdictLabel;
  /** Confidence score 0-1 based on the strength of the evidence */
  confidence: number;
  /** Human-readable explanation of the verdict */
  explanation: string;
  /** Sources used to reach this verdict */
  citations: Citation[];
  /** Warnings about the verification (e.g., source diversity issues) */
  warnings?: string[];
  /** Explanation of why confidence is at this level */
  confidenceExplanation?: string;
  /** Full research report markdown produced by Tavily's research endpoint */
  report?: string;
  /** Short one-paragraph summary of the report */
  summary?: string;
  /** How long the research call took, in seconds */
  researchTimeSeconds?: number;
}

// ============================================================================
// TAVILY RESEARCH API TYPES
// ============================================================================

export type TavilyResearchModel = 'auto' | 'mini' | 'pro';
export type TavilyCitationFormat = 'numbered' | 'mla' | 'apa' | 'chicago';
export type TavilyResearchStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Request body for POST /research
 */
export interface TavilyResearchRequest {
  input: string;
  model?: TavilyResearchModel;
  stream?: boolean;
  output_schema?: Record<string, unknown>;
  citation_format?: TavilyCitationFormat;
}

/**
 * A single source returned by the research endpoint
 */
export interface TavilyResearchSource {
  title?: string;
  url: string;
  favicon?: string;
  snippet?: string;
  published_date?: string;
}

/**
 * Response shape for POST /research (initial submission)
 */
export interface TavilyResearchSubmission {
  request_id: string;
  created_at: string;
  status: TavilyResearchStatus;
  input: string;
  model: string;
  response_time?: number;
}

/**
 * Response shape for GET /research/{request_id}
 */
export interface TavilyResearchResult {
  request_id: string;
  created_at: string;
  status: TavilyResearchStatus;
  /** Markdown report content when status is completed */
  content?: string | Record<string, unknown>;
  sources?: TavilyResearchSource[];
  response_time?: number;
  error?: string;
}

/**
 * Structured output schema the extension asks Tavily to return.
 * This mirrors the verdict we surface to the user.
 */
export interface TavilyStructuredVerdict {
  verdict: VerdictLabel;
  confidence: number;
  summary: string;
  explanation: string;
  report: string;
  key_findings?: string[];
  warnings?: string[];
}

// ============================================================================
// LIVE RESEARCH STATUS
// ============================================================================

export type ResearchStage =
  | 'submitting'
  | 'searching'
  | 'analyzing'
  | 'synthesizing'
  | 'finalizing';

/**
 * Real-time progress event emitted while a research task is in flight.
 * Used to drive the animated loading screen with a sense of streaming.
 */
export interface ResearchStatus {
  stage: ResearchStage;
  message: string;
  elapsedSeconds: number;
}

// ============================================================================
// PAGE FACT-CHECKER TYPES
// ============================================================================

export type LLMProvider = 'anthropic' | 'openai';

/**
 * A claim extracted by the LLM from a full webpage. Carries both the
 * canonical research-ready text and the verbatim sentence to find in the DOM.
 */
export interface PageClaim {
  id: string;
  /** Self-contained restatement suitable for the research agent. */
  text: string;
  /** Exact sentence as it appears in the article — used for DOM matching. */
  originalSentence: string;
}

export type PageFactCheckStage =
  | 'extracting'
  | 'identifying-claims'
  | 'researching'
  | 'complete'
  | 'error';

export interface PageFactCheckProgress {
  stage: PageFactCheckStage;
  message: string;
  claimsTotal?: number;
  claimsCompleted?: number;
}

// ============================================================================
// MESSAGE TYPES (Chrome Extension Communication)
// ============================================================================

/**
 * Message types for communication between extension components
 */
export type ExtensionMessage =
  | { type: 'VERIFY_TEXT'; text: string }
  | { type: 'CANCEL_VERIFY_TEXT' }
  | { type: 'VERIFY_SELECTED_TEXT' }
  | { type: 'GET_SELECTED_TEXT' }
  | { type: 'SELECTED_TEXT_RESPONSE'; text: string | null }
  | { type: 'GET_ARTICLE_TEXT' }
  | { type: 'VERIFICATION_STARTED' }
  | { type: 'VERIFICATION_PROGRESS'; stage: string; progress: number }
  | { type: 'VERIFICATION_COMPLETE'; claims: Claim[]; verdicts: Verdict[] }
  | { type: 'VERIFICATION_ERROR'; error: string }
  | { type: 'RESEARCH_STATUS'; claimId: string; status: ResearchStatus }
  | { type: 'SET_API_KEY'; apiKey: string }
  | { type: 'GET_API_KEY' }
  | { type: 'API_KEY_RESPONSE'; hasKey: boolean }
  | { type: 'GET_RESEARCH_SETTINGS' }
  | { type: 'SET_RESEARCH_SETTINGS'; settings: ResearchSettings }
  | { type: 'SET_LLM_API_KEY'; provider: LLMProvider; apiKey: string }
  | { type: 'GET_LLM_API_KEY_STATUS' }
  | { type: 'GET_ERROR_LOG' }
  | { type: 'CLEAR_ERROR_LOG' }
  | { type: 'FACT_CHECK_PAGE' }
  | { type: 'CANCEL_FACT_CHECK_PAGE' }
  | { type: 'FACT_CHECK_PAGE_PROGRESS'; progress: PageFactCheckProgress }
  | { type: 'FACT_CHECK_PAGE_CLAIMS'; claims: PageClaim[] }
  | { type: 'FACT_CHECK_PAGE_CLAIM_STATUS'; claimId: string; status: ResearchStatus }
  | { type: 'FACT_CHECK_PAGE_VERDICT'; claim: PageClaim; verdict: Verdict }
  | { type: 'FACT_CHECK_PAGE_DONE' }
  | { type: 'FACT_CHECK_PAGE_ERROR'; error: string }
  | { type: 'ANNOTATE_CLAIM'; claim: PageClaim; verdict: Verdict }
  | { type: 'CLEAR_ANNOTATIONS' };

// ============================================================================
// RESEARCH SETTINGS
// ============================================================================

export interface ResearchSettings {
  model: TavilyResearchModel;
  citationFormat: TavilyCitationFormat;
  llmProvider: LLMProvider;
  maxClaimsPerPage: number;
  showCreditUsage: boolean;
}

export interface LLMKeyStatus {
  anthropic: boolean;
  openai: boolean;
}

/**
 * Verification pipeline state
 */
export interface VerificationState {
  status: 'idle' | 'extracting' | 'searching' | 'analyzing' | 'complete' | 'error';
  progress: number;
  claims: Claim[];
  verdicts: Verdict[];
  error?: string;
}
