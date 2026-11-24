import { describe, expect, it } from "vitest";
import type { MailAdapter } from "@lifestreamprotocol/core";
import { BLOB, statedOf } from "../test/stated.js";
import { mailFaults } from "./faults.js";

describe("mailFaults", () => {
  it("passes a mail whose blob is a blob hash, or none", () => {
    expect(mailFaults(statedOf<MailAdapter>({}, "mail", { blob: BLOB }))).toEqual([]);
    expect(mailFaults(statedOf<MailAdapter>({}, "mail", { blob: null }))).toEqual([]);
  });

  it("names a blob that is no blob hash", () => {
    expect(mailFaults(statedOf<MailAdapter>({}, "mail", { blob: BLOB.slice(7) }))).toEqual([`\`blob\` is \`sha256:\` and 64 lower-case hex digits: \`${BLOB.slice(7)}\` is none`]);
  });
});
