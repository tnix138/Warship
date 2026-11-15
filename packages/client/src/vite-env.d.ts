/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the game server URL. Defaults to same-origin `/ws`. */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
