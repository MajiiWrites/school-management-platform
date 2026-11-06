import crypto from 'crypto';

/**
 * Runtime config. Required secrets must be set in production; in development
 * safe ephemeral defaults are generated and a warning is logged so the API
 * can boot without a .env (Database/DevOps agents own .env.example).
 */
function loadPhoneKey(): Buffer {
  const raw = process.env.PHONE_ENC_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('PHONE_ENC_KEY must be 32 bytes, base64-encoded');
    }
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PHONE_ENC_KEY is required in production');
  }
  // eslint-disable-next-line no-console
  console.warn('[config] PHONE_ENC_KEY not set — using ephemeral dev key (encrypted phones will not survive restarts)');
  return crypto.randomBytes(32);
}

function secret(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} is required in production`);
  }
  // eslint-disable-next-line no-console
  console.warn(`[config] ${name} not set — using dev fallback`);
  return devFallback;
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  phoneEncKey: Buffer;
  frontendUrl: string;
  uploadDir: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  attendanceLinkTtlDays: number;
  smtpHost: string | undefined;
  smtpPort: number;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  mailFrom: string;
  bcryptRounds: number;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: secret('JWT_SECRET', 'dev-jwt-secret-change-me'),
  jwtRefreshSecret: secret('JWT_REFRESH_SECRET', 'dev-jwt-refresh-secret-change-me'),
  phoneEncKey: loadPhoneKey(),
  frontendUrl: (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  attendanceLinkTtlDays: Number(process.env.ATTENDANCE_LINK_TTL_DAYS ?? 90),
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  mailFrom: process.env.MAIL_FROM ?? 'School Management <no-reply@school.local>',
  bcryptRounds: 12,
};
