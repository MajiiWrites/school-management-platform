export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SESSION_EXPIRED'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_DISABLED'
  | 'SCHOOL_SUSPENDED'
  | 'MAINTENANCE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SESSION_EXPIRED: 401,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_DISABLED: 403,
  SCHOOL_SUSPENDED: 403,
  MAINTENANCE: 503,
  INTERNAL: 500,
};

/** Application error — the error middleware renders it as {ok:false, error:{code,message}}. */
export class ApiError extends Error {
  code: ErrorCode;
  status: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status ?? STATUS[code];
  }

  static validation(message: string): ApiError {
    return new ApiError('VALIDATION', message);
  }
  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission for this action'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError('NOT_FOUND', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message);
  }
  /** 6D: refresh token presented after the school's idle timeout. The
   * frontend treats this code as "session expired — sign in again". */
  static sessionExpired(message = 'Session expired due to inactivity — please sign in again'): ApiError {
    return new ApiError('SESSION_EXPIRED', message);
  }
  /** Phase 1 (real email verification, 2026-11-19): login/refresh/2FA
   * completion for an account whose email is not verified yet. The
   * frontend treats this code as "verify your email first" and offers a
   * resend button. */
  static emailNotVerified(
    message = 'Please verify your email before logging in. Check your inbox for the verification link, or resend it below.',
  ): ApiError {
    return new ApiError('EMAIL_NOT_VERIFIED', message);
  }
  /** Platform Admin Panel (2026-11-20): account disabled by the platform admin. */
  static accountDisabled(
    message = 'Your account has been disabled by the platform administrator. Please contact support.',
  ): ApiError {
    return new ApiError('ACCOUNT_DISABLED', message);
  }
  /** Platform Admin Panel (2026-11-20): the user's school is suspended. */
  static schoolSuspended(
    message = 'Your school has been suspended by the platform administrator. Please contact support.',
  ): ApiError {
    return new ApiError('SCHOOL_SUSPENDED', message);
  }
  /** Platform Admin Panel (2026-11-20): signup attempted while maintenance mode is on. */
  static maintenance(
    message = 'The platform is under maintenance. Please try again later.',
  ): ApiError {
    return new ApiError('MAINTENANCE', message);
  }
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export function asyncHandler(
  fn: (req: any, res: any, next: any) => Promise<unknown>,
): (req: any, res: any, next: any) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
