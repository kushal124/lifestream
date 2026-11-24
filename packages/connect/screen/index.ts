import type { Reader } from "../seams.js";
import { coastAcquirer } from "./coast/acquirer.js";
import { coast } from "./coast/reader.js";
import { screenRecorder } from "../macos-app/screen/reader.js";
import type { Adapters } from "@lifestreamprotocol/core";
import type { Connector } from "../declaration.js";
import { coastScreen } from "./coast/adapter.js";
import { recorderScreen } from "../macos-app/screen/adapter.js";
import { coast as coastConnector } from "./coast/connector.js";
import { screen } from "../macos-app/screen/connector.js";

export { coastAcquirer, type CoastCursor, type CoastSettings } from "./coast/acquirer.js";
export { CoastShapeUnknown, type CoastShape } from "./coast/shape.js";
export { VIDEO_DIRECTORY } from "./coast/reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [coastConnector, screen];
export const readers: Reader[] = [coast, screenRecorder];
export const acquirers = { coast: coastAcquirer };
export const adapters: Readonly<Record<string, Adapters>> = { coast: { screen: coastScreen }, screen: { screen: recorderScreen } };
