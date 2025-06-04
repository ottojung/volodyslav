declare module 'virtual:pwa-register' {
  import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
  export type { RegisterSWOptions };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export function registerSW(_options?: RegisterSWOptions): (_reloadPage?: boolean) => Promise<void>;
}
