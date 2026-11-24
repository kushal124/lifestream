import { checks, isObject, type PageResponse } from "@lifestreamprotocol/connect/sdk";

const { uuid } = checks;

export function chatOrganization(listed: PageResponse): string {
  const chat = (Array.isArray(listed.json) ? listed.json : []).find((each) =>
    isObject(each) && Array.isArray(each.capabilities) && each.capabilities.includes("chat") && typeof each.uuid === "string" && uuid(each.uuid));
  if (!isObject(chat)) throw new Error(`claude.ai answered ${listed.status} and lists no organization that chats`);
  return chat.uuid as string;
}
