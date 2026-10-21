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
