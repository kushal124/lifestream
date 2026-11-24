import type { Acquirer, Adapters, Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { githubApiAcquirer, type GithubApiSettings } from "./acquirer.js";
import { line } from "./adapter.js";
import { githubApi } from "./reader.js";
import { github } from "./connector.js";

export { githubApi } from "./reader.js";
export { githubApiAcquirer, type GithubApiSettings, type GithubApiState } from "./acquirer.js";

export const contract = 3;
export const connectors: readonly Connector[] = [github];
export const readers: Reader[] = [githubApi];
export const acquirers: Record<string, (settings: GithubApiSettings) => Acquirer> = { "github-api": githubApiAcquirer };
export const adapters: Readonly<Record<string, Adapters>> = { [github.id]: { line } };
