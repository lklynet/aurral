/// <reference types="vite-plus/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_RELEASE_CHANNEL?: string;
}
