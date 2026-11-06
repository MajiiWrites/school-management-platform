import type { AccessPayload } from '../lib/tokens';

declare global {
  namespace Express {
    interface Request {
      user?: AccessPayload;
      schoolId?: string;
    }
  }
}

export {};
