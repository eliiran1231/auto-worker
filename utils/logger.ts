import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<Record<string, unknown>>();

export function withLogContext<T>(fields: Record<string, unknown>, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

export function redact(text: string): string {
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || !/TOKEN|SECRET|PASSWORD|API_KEY/i.test(name)) continue;
    for (const secret of [value, Buffer.from(`x-access-token:${value}`).toString("base64")]) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text.replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[REDACTED]");
}

function write(level: "error", message: string, fields: Record<string, unknown> = {}): void {
  const seen = new WeakSet<object>();
  const details = JSON.stringify({ ...context.getStore(), ...fields }, (key, value) => {
    if (/^(authorization|cookie|token|secret|password|apiKey|signature)$/i.test(key)) return "[REDACTED]";
    if (typeof value === "string") return redact(value);
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack,
        ...(value instanceof AggregateError ? { errors: value.errors } : {}) };
    }
    return value;
  });
  console[level](redact(`${new Date().toISOString()} ${level.toUpperCase()} ${message} ${details}`));
}

export const logger = {
  agent: (role: string, engine: string, workerId: string, message: string) => {
    const prefix = `${new Date().toISOString()} [${role.toUpperCase()} ${engine} ${workerId.slice(0, 8)}]`;
    for (const line of redact(message).split(/\r?\n/)) {
      console.info(`${prefix} ${line}`);
    }
  },
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
