export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
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
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export function asyncHandler(
  fn: (req: any, res: any, next: any) => Promise<unknown>,
): (req: any, res: any, next: any) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
