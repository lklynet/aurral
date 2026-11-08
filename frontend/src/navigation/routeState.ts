import { isRecord } from "../../../lib/isRecord.ts";

export const stateText = (value: unknown) => (typeof value === "string" ? value : undefined);

export const routeStateOf = (state: unknown): Record<string, unknown> =>
  isRecord(state) ? state : {};
