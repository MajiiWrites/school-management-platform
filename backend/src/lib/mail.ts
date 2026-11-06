import nodemailer from 'nodemailer';
import { config } from '../config';

/**
 * Email sender. If SMTP env is set, sends via SMTP; otherwise (dev) the
 * message is logged to the console and the function resolves — verification
 * and reset tokens are never lost in dev (contracts/STRUCTURE.md).
 */
export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<void> {
  if (!config.smtpHost) {
    // eslint-disable-next-line no-console
    console.log(`[dev-mail] To: ${opts.to}\nSubject: ${opts.subject}\n${opts.text}\n`);
    return;
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  await transporter.sendMail({ from: config.mailFrom, ...opts });
}

export function verificationEmailBody(schoolName: string, token: string): { subject: string; text: string } {
  const link = `${config.frontendUrl}/verify-email?token=${token}`;
  return {
    subject: `Verify your email — ${schoolName} (School Management)`,
    text: `Welcome to School Management Platform!\n\nPlease verify your email for ${schoolName} by opening this link:\n${link}\n\nThe link expires in 24 hours.\n\nIf you did not create this account, please ignore this email.`,
  };
}

export function resetPasswordEmailBody(schoolName: string, token: string): { subject: string; text: string } {
  const link = `${config.frontendUrl}/reset-password?token=${token}`;
  return {
    subject: `Reset your password — ${schoolName} (School Management)`,
    text: `You asked to reset your password for ${schoolName}.\n\nOpen this link to set a new password:\n${link}\n\nThe link expires in 1 hour. If you did not ask for this, please ignore this email.`,
  };
}
