const ERROR_LOG_KEY = 'errorLog';
const MAX_ERROR_LOG_ENTRIES = 50;

export interface ErrorLogEntry {
  timestamp: string;
  source: string;
  message: string;
  details?: string;
}

export async function appendErrorLog(entry: Omit<ErrorLogEntry, 'timestamp'>): Promise<void> {
  try {
    const existing = await getErrorLog();
    const next: ErrorLogEntry[] = [
      {
        timestamp: new Date().toISOString(),
        ...entry,
      },
      ...existing,
    ].slice(0, MAX_ERROR_LOG_ENTRIES);

    await chrome.storage.local.set({ [ERROR_LOG_KEY]: next });
  } catch (error) {
    console.warn('[ErrorLog] Could not persist error log entry:', error);
  }
}

export async function getErrorLog(): Promise<ErrorLogEntry[]> {
  const result = await chrome.storage.local.get(ERROR_LOG_KEY);
  const value = result[ERROR_LOG_KEY];
  return Array.isArray(value) ? (value as ErrorLogEntry[]) : [];
}

export async function clearErrorLog(): Promise<void> {
  await chrome.storage.local.remove(ERROR_LOG_KEY);
}

export function formatErrorLog(entries: ErrorLogEntry[]): string {
  if (entries.length === 0) {
    return 'No error log entries.';
  }

  return entries
    .map((entry) => {
      const lines = [`[${entry.timestamp}] ${entry.source}: ${entry.message}`];
      if (entry.details) {
        lines.push(entry.details);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
