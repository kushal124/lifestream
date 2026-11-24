import { HOME_DB, LEDGER_DB, type StorageOrigin } from "@lifestreamprotocol/core";

export interface JobError { message: string; code?: string; database?: StorageOrigin }

export function jobError(error: unknown): JobError {
  const { message, code, database } = (error ?? {}) as { message?: unknown; code?: unknown; database?: unknown };
  return {
    message: typeof message === "string" ? message : String(error),
    ...(typeof code === "string" ? { code } : {}),
    ...(database === HOME_DB || database === LEDGER_DB ? { database } : {}),
  };
}

export function errorText(error: unknown): string {
  const { message, code } = jobError(error);
  return code?.startsWith("SQLITE_") === true && !message.includes(code) ? `${code}: ${message}` : message;
}
