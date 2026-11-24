import { createPageAgent, type PageAgent } from "./page.js";

declare global {
  var __lifestreamPage: PageAgent | undefined;
}

globalThis.__lifestreamPage ??= createPageAgent(window as Window & typeof globalThis);
