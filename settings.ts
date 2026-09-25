import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { Settings } from "./interfaces/Settings.js";

const settingsUrls = [
  new URL("./settings.json", import.meta.url),
  new URL("../settings.json", import.meta.url),
];
const settingsUrl = settingsUrls.find((url) => existsSync(url));

if (!settingsUrl) {
  throw new Error("settings.json was not found");
}
const settingsFileUrl = settingsUrl;

export const settings = JSON.parse(
  readFileSync(settingsFileUrl, "utf8"),
) as Settings;
if (!settings.github.username.trim()) {
  throw new Error("Set github.username in settings.json");
}

function validate(candidate: unknown, current: unknown, path = "settings"): void {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
      typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`${path} must be an object`);
  }
  const proposed = candidate as Record<string, unknown>;
  const existing = current as Record<string, unknown>;
  if (Object.keys(proposed).sort().join("|") !== Object.keys(existing).sort().join("|")) {
    throw new Error(`${path} must contain exactly the existing keys`);
  }
  for (const [key, value] of Object.entries(existing)) {
    const next = proposed[key];
    if (typeof value === "object" && value !== null) validate(next, value, `${path}.${key}`);
    else if (typeof next !== typeof value || (typeof next === "string" && !next.trim()) ||
      (typeof next === "number" && (!Number.isFinite(next) || next < 0))) {
      throw new Error(`Invalid ${path}.${key}`);
    }
  }
}

let saveQueue = Promise.resolve();

export function updateSettings(candidate: unknown): Promise<Settings> {
  const save = saveQueue.then(async () => {
    validate(candidate, settings);
    const next = candidate as Settings;
    if (JSON.stringify(next.server) !== JSON.stringify(settings.server)) {
      throw new Error("Server ports and webhook path require a restart");
    }
    if (!next.github.username.trim()) throw new Error("Set github.username");
    const target = new URL(settingsFileUrl);
    const temporary = new URL(`${target.pathname}.tmp`, target);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    Object.assign(settings, next);
    return settings;
  });
  saveQueue = save.then(() => undefined, () => undefined);
  return save;
}
