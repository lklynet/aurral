import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import type { websocketService } from "../../backend/services/websocketService.ts";

export function testUser(id: number, overrides: Partial<RequestUser> = {}): RequestUser {
  return { id, username: `user-${id}`, role: "user", permissions: {}, ...overrides };
}

type WebSocketClient = Parameters<typeof websocketService.clients.add>[0];

export function testWebSocketClient(
  userId: number,
  subscriptions: string[],
  send: (message: string) => unknown,
): WebSocketClient {
  return {
    id: `client-${userId}`,
    user: {
      id: userId,
      username: `user-${userId}`,
      role: "user",
      permissions: {
        accessSettings: false,
        accessFlow: false,
        addArtist: false,
        addAlbum: false,
        changeMonitoring: false,
        deleteArtist: false,
        deleteAlbum: false,
        deleteTrack: false,
      },
    },
    authSource: "session",
    connectedAt: 0,
    subscriptions: new Set(subscriptions),
    ws: { readyState: 1, send } as unknown as WebSocketClient["ws"],
  };
}
