import { isRecord } from "../../../lib/isRecord.ts";

export const routeStateOf = (state: unknown): Record<string, unknown> =>
  isRecord(state) ? state : {};
