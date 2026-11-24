import type { Adapter, InputRecord } from "./adapter.js";

/** How an address book's records become the cards People names people by. */
export interface LabelsAdapter extends Adapter {
  /** One record's card as vCard text, which People reads in place of a card in the record's content, or null to keep the content's own. */
  card?(record: InputRecord): string | null;
}
