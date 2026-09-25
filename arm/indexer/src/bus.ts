import { EventEmitter } from "node:events";

/** In-process event bus: indexer → websocket broadcaster / keeper. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export type WsMessage =
  | { type: "trade"; data: Record<string, unknown> }
  | { type: "launch"; data: Record<string, unknown> }
  | { type: "fees"; data: Record<string, unknown> }
  | { type: "graduated"; data: Record<string, unknown> };
