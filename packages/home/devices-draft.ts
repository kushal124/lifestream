import { canonical, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { bad, single, statedHead, verbOf, type Drafted, type Drafter, type DraftRead, type Statement } from "./owner-act.js";
import { refuse } from "./refusal.js";

const VERBS = { camera: ["camera", "mine", "from", "to"], forget: ["camera"] } as const;

export const devicesDrafter: Drafter = {
  draft({ view, source }: DraftRead, action: JsonObject): Drafted {
    const verb = verbOf(action, VERBS, "A camera's action is camera or forget.");
    const camera = typeof action.camera === "string" && action.camera !== "" ? action.camera : bad("A word names its camera.");
    const head = statedHead(view, source, "camera", camera);
    const drafted = (statement: Statement | null): Drafted => single(verb, statement, `camera:${camera}`);
    if (verb === "forget") {
      if (head === undefined) refuse(404, "CAMERA_UNKNOWN", "There is no word on that camera.");
      return drafted({ kind: "camera", key: camera, gone: true });
    }
    if (typeof action.mine !== "boolean") bad("A word says whether the camera is yours.");
    const content: JsonObject = { type: "devices.camera", mine: action.mine, ...dated("from", action.from), ...dated("to", action.to) };
    return drafted(head !== undefined && canonical(head) === canonical(content) ? null : { kind: "camera", key: camera, content });
  },
};

function dated(bound: "from" | "to", value: Json | undefined): JsonObject {
  if (value === undefined || value === null || value === "") return {};
  return typeof value === "string" ? { [bound]: value } : bad(`A word's ${bound} is a date.`);
}

