import { describe, expect, it } from "vitest";
import { canonicalNetwork, compareHandles, handleFrom, handleId, handleOf, networkHandle, RESERVED_NETWORKS, type Handle } from "./handles.js";
import { personRecordFaults, readPersonRecord } from "./people-record.js";

describe("the network handle", () => {
  it("spells <product>:<id> in NFC, and refuses an empty id, a space, a control character, a product misspelled or reserved", () => {
    expect(networkHandle("example-chat", "12345")).toBe("example-chat:12345");
    expect(networkHandle("example-chat", "Café")).toBe("example-chat:Café");
    expect(networkHandle("example-chat", "user:with:colons")).toBe("example-chat:user:with:colons");
    expect(["", "a b", "a\tb", "a\u0000b", "a\u007fb", "a b"].map((id) => networkHandle("example-chat", id))).toEqual([null, null, null, null, null, null]);
    expect(["Example", "-chat", "chat:x", ""].map((product) => networkHandle(product, "1"))).toEqual([null, null, null, null]);
    expect(RESERVED_NETWORKS.map((product) => networkHandle(product, "a1"))).toEqual(RESERVED_NETWORKS.map(() => null));
  });

  it("is read only where the id is no JID, phone or address, and only given its network", () => {
    expect(handleOf("user-a1", "example-chat")).toEqual({ kind: "network", value: "example-chat:user-a1" });
    expect(handleOf("user-a1")).toBeNull();
    expect(handleOf("+15550000001", "example-chat")).toEqual({ kind: "phone", value: "+15550000001" });
    expect(handleOf("15550000001@s.whatsapp.net", "example-chat")).toEqual({ kind: "phone", value: "+15550000001" });
    expect(handleOf("12345@lid", "example-chat")).toEqual({ kind: "jid", value: "12345@lid" });
    expect(handleOf("Person-A@Example.com", "example-chat")).toEqual({ kind: "email", value: "person-a@example.com" });
    expect(handleOf("a b", "example-chat")).toBeNull();
  });

  it("holds a stored value to its one spelling: none whose id is a spelled phone, an address or a WhatsApp id", () => {
    expect(canonicalNetwork("example-chat:user-a1")).toBe("example-chat:user-a1");
    expect(["example-chat:+15550000001", "example-chat:person-a@example.com", "example-chat:12345@lid", "example-chat:", "phone:user-a1", "user-a1", "example-chat:a b"].map(canonicalNetwork))
      .toEqual([null, null, null, null, null, null, null]);
    expect(handleFrom("network", "example-chat:user-a1")).toEqual({ kind: "network", value: "example-chat:user-a1" });
    expect(handleFrom("network", "example-chat:+15550000001")).toBeNull();
    expect(handleFrom("network", "example-chat:123456789")).toEqual({ kind: "network", value: "example-chat:123456789" });
    expect(handleOf("123456789", "example-chat")).toEqual({ kind: "phone", value: "+123456789" });
    expect(handleFrom("jid", "15550000001@s.whatsapp.net")).toEqual({ kind: "phone", value: "+15550000001" });
    expect(handleFrom("name", "Person A")).toBeNull();
  });

  it("is its value alone as an id; the other kinds keep <kind>:<value>", () => {
    expect(handleId({ kind: "network", value: "example-chat:12345" })).toBe("example-chat:12345");
    expect(handleId({ kind: "phone", value: "+15550000001" })).toBe("phone:+15550000001");
    expect(handleId({ kind: "email", value: "person-a@example.com" })).toBe("email:person-a@example.com");
    expect(handleId({ kind: "jid", value: "12345@lid" })).toBe("jid:12345@lid");
  });

  it("sorts after phones, addresses and WhatsApp ids, then by value", () => {
    const handles: Handle[] = [
      { kind: "network", value: "example-chat:b" }, { kind: "jid", value: "12345@lid" }, { kind: "network", value: "example-chat:a" },
      { kind: "email", value: "person-a@example.com" }, { kind: "phone", value: "+15550000001" },
    ];
    expect([...handles].sort(compareHandles).map(handleId)).toEqual([
      "phone:+15550000001", "email:person-a@example.com", "jid:12345@lid", "example-chat:a", "example-chat:b",
    ]);
  });
});

describe("a person record with network handles", () => {
  const record = (over: Record<string, unknown>) => ({
    type: "people.person", slug: "person-a", name: "Person A", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: null, handles: [], excluded: [], dismissed: [], merged_into: null, ...over,
  });

  it("accepts one in handles, anchor and excluded, in core's order, and reads each back", () => {
    const content = record({
      anchor: { kind: "network", value: "example-chat:a" },
      handles: [{ kind: "phone", value: "+15550000001" }, { kind: "network", value: "example-chat:b" }],
      excluded: [{ kind: "network", value: "example-chat:c" }],
    });
    expect(personRecordFaults(content)).toEqual([]);
    const read = readPersonRecord(content)!;
    expect([read.anchor, read.handles, read.excluded]).toEqual([
      { kind: "network", value: "example-chat:a" },
      [{ kind: "phone", value: "+15550000001" }, { kind: "network", value: "example-chat:b" }],
      [{ kind: "network", value: "example-chat:c" }],
    ]);
  });

  it("refuses one out of order, misspelled, a phone spelled as a network's, or held and excluded both", () => {
    expect(personRecordFaults(record({ handles: [{ kind: "network", value: "example-chat:b" }, { kind: "phone", value: "+15550000001" }] }))).toEqual([
      "handles must be sorted as core orders handles (phones, addresses, WhatsApp ids, networks', each by value), without repeats",
    ]);
    expect(personRecordFaults(record({ handles: [{ kind: "network", value: "example-chat:+15550000001" }] }))).toEqual(["handles[0].value is not a network in its canonical spelling"]);
    expect(personRecordFaults(record({ anchor: { kind: "network", value: "example-chat:a b" } }))).toEqual(["anchor.value is not a network in its canonical spelling"]);
    expect(personRecordFaults(record({ handles: [{ kind: "network", value: "example-chat:a" }], excluded: [{ kind: "network", value: "example-chat:a" }] }))).toEqual([
      "a handle is both held and excluded",
    ]);
  });

  it("reads phone, address and WhatsApp handles exactly as before", () => {
    const content = record({
      anchor: { kind: "jid", value: "15550000001@s.whatsapp.net" },
      handles: [{ kind: "email", value: "person-a@example.com" }, { kind: "jid", value: "12345@lid" }],
    });
    expect(personRecordFaults(content)).toEqual([]);
    const read = readPersonRecord(content)!;
    expect([read.anchor, read.handles]).toEqual([
      { kind: "phone", value: "+15550000001" },
      [{ kind: "email", value: "person-a@example.com" }, { kind: "jid", value: "12345@lid" }],
    ]);
  });
});
