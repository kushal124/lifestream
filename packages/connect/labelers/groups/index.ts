import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { groups } from "./connector.js";
import { groupsConnector } from "./reader.js";
import { groupsLabeler } from "./labeler.js";

export const contract = 3;
export const connectors: readonly Connector[] = [groups];
export const readers: Reader[] = [groupsConnector];
export const labelers = { groups: groupsLabeler };
export { GROUPS_FILE, groupsConnector, groupsLine, MONTH_KIND, type DaySpan, type Month } from "./reader.js";
export { groupsLabeler, monthSpans, monthsOf, PEOPLE_EVENT, PER_RUN, type GroupRow, type GroupsSettings, type PreparedGroups } from "./labeler.js";
