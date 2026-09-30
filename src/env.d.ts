/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Prefix every API request is built against. Defaults to `/iam`. */
  readonly TUCONSOLE_API_BASE?: string
  /**
   * `1` installs the in-memory mock backend in a dev build (`src/api/mock`).
   * Ignored in production, where `import.meta.env.DEV` is `false`.
   */
  readonly TUCONSOLE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
