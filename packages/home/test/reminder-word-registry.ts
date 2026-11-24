import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withRoadDefaults, type Connector, type Reader } from "@lifestreamprotocol/connect";
import type { CalendarAdapter, Guard, JsonObject } from "@lifestreamprotocol/core";
import { connectorsWith, families } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";

export const WORD_FILE = "reminder-word.json";

const EXAMPLE_TASKS: Connector = withRoadDefaults({
  id: "example-tasks", product: "example-tasks", name: "Example tasks", vendor: "example", type: "plans", records: "Tasks an example service keeps.",
  noun: ["task", "tasks"], sources: [{ id: "example-tasks:local:<home>", read: "example-tasks-rows", arrives: "upload" }],
});

const task: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.title === "string" && typeof content.done === "number"
  ? [] : ["a task states title and done"];

const rows: Reader = { ...fakeRows, name: "example-tasks-rows", kinds: { reminder: task } };

function store(word: string): CalendarAdapter {
  const read = (content: unknown) => content as JsonObject & { title: string; done: number };
  return {
    version: "1", kinds: ["reminder"], authority: "own", keys: "name", units: "account", reminderWord: word,
    reminder({ version }) {
      const { title, done } = read(version.content);
      return { value: { title, due: null, completed: true, completed_ms: done, list: null, flagged: false }, modified: done };
    },
    words({ version }) {
      return { title: read(version.content).title, text: "", who: [] };
    },
  };
}

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const { word } = JSON.parse(readFileSync(join(folder, WORD_FILE), "utf8")) as { word: string };
  return {
    connectors: connectorsWith([EXAMPLE_TASKS]), readers: [rows],
    families: families(settings, folder, [{ connectors: [EXAMPLE_TASKS], adapters: { "example-tasks": { calendar: store(word) } } }]),
  };
}
