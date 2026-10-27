import { postData } from "../core.ts";
import type { recordPlayEvent as recordPlayEventService } from "../../../../../backend/services/playEventService.ts";

type PlayEventPayload = NonNullable<Parameters<typeof recordPlayEventService>[1]>;

export const recordPlayEvent = (
  payload: PlayEventPayload,
): Promise<{ event: ReturnType<typeof recordPlayEventService> }> =>
  postData("/play-events", payload);
