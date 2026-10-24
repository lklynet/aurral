import type { HttpBindings } from "@hono/node-server";

export interface RequestUser {
  id: number;
  username: string;
  role: string;
  permissions: Record<string, unknown>;
  status?: string;
  isProtected?: boolean;
  roleSource?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: RequestUser;
    }
  }
}

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    user?: RequestUser;
    clientIp: string;
  };
};
