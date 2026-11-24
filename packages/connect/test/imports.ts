import type { BlobReader, Delivery } from "@lifestreamprotocol/core";
import { declarations, providers } from "../index.js";
import { importKinds, listImport, type ImportKind, type Listing, type Resolved, type Stated } from "../imports/index.js";

export function releaseKind(id: string): ImportKind {
  return importKinds(declarations(), providers().flatMap((provider) => provider.readers)).find((kind) => kind.id === id) ?? (() => { throw new Error(`no import kind ${id}`); })();
}

export async function looked(id: string, delivery: Delivery, blobs: BlobReader, anchor: string | null = null): Promise<{ listing: Listing; resolved: Resolved; stated: Stated }> {
  const kind = releaseKind(id);
  const { listing, found } = await listImport(kind, delivery, blobs, {
    look: async (members) => ({ resolved: await kind.resolve(members), stated: await kind.states(delivery.files[0]!.path, members, anchor) }),
  });
  return { listing, ...found };
}
