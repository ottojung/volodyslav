declare module 'virtual:pwa-register' {
  import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
  export type { RegisterSWOptions };
  export function registerSW(_options?: RegisterSWOptions): (_reloadPage?: boolean) => Promise<void>;
}
