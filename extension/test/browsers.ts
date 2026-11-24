declare module "vitest" {
  export interface ProvidedContext {
    googleChrome: string;
    chromeForTesting: string | null;
  }
}

export {};
