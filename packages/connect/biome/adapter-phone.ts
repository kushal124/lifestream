import { isObject, type Adapters, type Focus, type InputRecord, type Json } from "@lifestreamprotocol/connect/sdk";

export const phoneAdapters: Readonly<Record<string, Pick<Adapters, "phone">>> = {
  "screen-time": {
    phone: {
      version: "1",
      kinds: ["app-focus"],
      focus({ version }: InputRecord): Focus | null {
        const device = deviceOf(version.key);
        const fields = isObject(version.content) && isObject(version.content.fields) ? version.content.fields : {};
        const app = text(fields["6"]);
        if (device === null || app === null || (fields["3"] !== 0 && fields["3"] !== 1)) return null;
        return { device, app, in: fields["3"] === 1 };
      },
    },
  },
};

export function deviceOf(key: string): string | null {
  const colon = key.indexOf(":");
  return colon <= 0 ? null : key.slice(0, colon);
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
