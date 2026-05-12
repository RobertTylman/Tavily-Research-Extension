type LangSmithRunType = 'chain' | 'llm' | 'tool' | 'parser';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

interface LangSmithRunOptions {
  name: string;
  runType: LangSmithRunType;
  inputs?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  tags?: string[];
  parent?: LangSmithRun | null;
}

interface LangSmithEndOptions {
  outputs?: Record<string, JsonValue>;
  error?: unknown;
  metadata?: Record<string, JsonValue>;
}

interface LangSmithConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  project: string;
  workspaceId?: string;
  sampleRate: number;
}

const DEFAULT_ENDPOINT = 'https://api.smith.langchain.com';
const DEFAULT_PROJECT = 'fact-checker';
const MAX_TEXT_PREVIEW = 240;

const config: LangSmithConfig = {
  enabled: import.meta.env.VITE_LANGSMITH_TRACING === 'true',
  apiKey: import.meta.env.VITE_LANGSMITH_API_KEY || '',
  endpoint: trimTrailingSlash(import.meta.env.VITE_LANGSMITH_ENDPOINT || DEFAULT_ENDPOINT),
  project: import.meta.env.VITE_LANGSMITH_PROJECT || DEFAULT_PROJECT,
  workspaceId: import.meta.env.VITE_LANGSMITH_WORKSPACE_ID || undefined,
  sampleRate: parseSampleRate(import.meta.env.VITE_LANGSMITH_SAMPLE_RATE),
};
const sampled = shouldSample();

export class LangSmithRun {
  readonly id = crypto.randomUUID();
  readonly startTime = new Date();

  constructor(
    readonly name: string,
    readonly runType: LangSmithRunType,
    readonly parentId?: string
  ) {}

  async end(options: LangSmithEndOptions = {}): Promise<void> {
    if (!isLangSmithConfigured()) return;

    const payload: Record<string, unknown> = {
      end_time: new Date().toISOString(),
    };

    if (options.outputs) {
      payload.outputs = options.outputs;
    }

    if (options.error) {
      payload.error = formatError(options.error);
    }

    if (options.metadata) {
      payload.extra = { metadata: options.metadata };
    }

    await sendLangSmithRequest(`/runs/${this.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }
}

export function isLangSmithConfigured(): boolean {
  return config.enabled && Boolean(config.apiKey) && sampled;
}

export async function startLangSmithRun(
  options: LangSmithRunOptions
): Promise<LangSmithRun | null> {
  if (!isLangSmithConfigured()) return null;

  const run = new LangSmithRun(options.name, options.runType, options.parent?.id);
  const payload: Record<string, unknown> = {
    id: run.id,
    name: options.name,
    run_type: options.runType,
    inputs: options.inputs ?? {},
    start_time: run.startTime.toISOString(),
    session_name: config.project,
    tags: options.tags ?? [],
    extra: {
      metadata: options.metadata ?? {},
    },
  };

  if (options.parent) {
    payload.parent_run_id = options.parent.id;
  }

  await sendLangSmithRequest('/runs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return run;
}

export function summarizeText(text: string): Record<string, JsonValue> {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    length: text.length,
    preview:
      normalized.length > MAX_TEXT_PREVIEW
        ? `${normalized.slice(0, MAX_TEXT_PREVIEW)}...`
        : normalized,
  };
}

export function summarizeUrl(url: string): Record<string, JsonValue> {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
    };
  } catch {
    return { value: url };
  }
}

export function getLangSmithProjectName(): string {
  return config.project;
}

async function sendLangSmithRequest(path: string, init: RequestInit): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    };

    if (config.workspaceId) {
      headers['x-tenant-id'] = config.workspaceId;
    }

    const response = await fetch(`${config.endpoint}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      console.warn(
        `[LangSmith] Trace request failed: ${response.status} ${response.statusText}`,
        body.slice(0, 300)
      );
    }
  } catch (error) {
    console.warn('[LangSmith] Trace request failed:', error);
  }
}

function shouldSample(): boolean {
  if (config.sampleRate >= 1) return true;
  if (config.sampleRate <= 0) return false;
  return Math.random() < config.sampleRate;
}

function parseSampleRate(value: string | undefined): number {
  if (!value) return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(1, parsed));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
