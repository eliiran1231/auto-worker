import nodemailer from "nodemailer";
import { settings, validateEmailSettings } from "../settings.js";

const reported = new WeakSet<object>();
const pending = new Set<Promise<void>>();

export async function sendTestEmail(): Promise<void> {
  await deliverEmail("Test email", "Your auto-worker email connection is working. Failure alerts will use this sender and recipient when enabled.");
}

async function deliverEmail(message: string, details: string): Promise<void> {
  const config = { ...settings.email, enabled: true };
  validateEmailSettings(config);
  const transport = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure,
    requireTLS: !config.secure,
    ...(config.username.trim() ? { auth: { user: config.username, pass: process.env[config.passwordEnv] } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ from: config.from, to: config.to,
      subject: `[auto-worker] ${message.replace(/[\r\n]/g, " ").slice(0, 180)}`, text: details });
  } catch {
    throw new Error("Email could not be sent. Check your SMTP server, port, security setting and password, then try again.");
  } finally { transport.close(); }
}

function wasReported(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (reported.has(error)) return true;
  return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(wasReported);
}

/** Receives the same redacted text as the error log; mail failures never recurse. */
export function sendFailureEmail(message: string, details: string, error?: unknown): void {
  const config = { ...settings.email };
  if (!config.enabled || wasReported(error)) return;
  if (error instanceof Error) reported.add(error);
  const delivery = (async () => {
    try {
      await deliverEmail(message, details);
    } catch {
      // SMTP errors may include credentials; preserve the original failure in the log.
      console.error("Failure email could not be sent. Check email settings, SMTP credentials and connectivity.");
      if (error instanceof Error) reported.delete(error);
    }
  })();
  pending.add(delivery);
  void delivery.finally(() => pending.delete(delivery));
}

export async function flushFailureEmails(): Promise<void> {
  await Promise.all([...pending]);
}
