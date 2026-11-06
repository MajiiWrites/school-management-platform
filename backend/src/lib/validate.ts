import { z } from 'zod';
import { ApiError } from './errors';

/** Parse a request body with a zod schema; throws 400 VALIDATION on failure. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw ApiError.validation(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request body');
  }
  return result.data;
}

/** Parse query params with a zod schema; unknown keys are ignored. */
export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    const first = result.error.issues[0];
    throw ApiError.validation(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid query parameters');
  }
  return result.data;
}

export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters');
export const emailSchema = z.string().email('Invalid email address');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
export const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM');
export const uuidSchema = z.string().uuid('Invalid id');
