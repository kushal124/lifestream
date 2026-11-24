import type { ImapClient, ImapConnection } from "./dependencies.js";

export async function imapflowClient(connection: ImapConnection): Promise<ImapClient> {
  const library = "imapflow";
  const { ImapFlow } = (await import(library)) as { ImapFlow: new (options: object) => ImapClient };
  return new ImapFlow({
    host: connection.host,
    port: connection.port,
    secure: true,
    auth: { user: connection.account, pass: connection.password },
    logger: false,
  });
}
