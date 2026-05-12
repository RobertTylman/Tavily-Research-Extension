/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LANGSMITH_TRACING?: string;
  readonly VITE_LANGSMITH_API_KEY?: string;
  readonly VITE_LANGSMITH_ENDPOINT?: string;
  readonly VITE_LANGSMITH_PROJECT?: string;
  readonly VITE_LANGSMITH_WORKSPACE_ID?: string;
  readonly VITE_LANGSMITH_SAMPLE_RATE?: string;
  readonly VITE_LANGSMITH_TEXT_MODE?: 'off' | 'preview' | 'full';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.png' {
  const src: string;
  export default src;
}
