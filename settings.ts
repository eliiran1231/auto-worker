import { existsSync, readFileSync } from "node:fs";
import type { Settings } from "./interfaces/Settings.js";

const settingsUrls = [
  new URL("./settings.json", import.meta.url),
  new URL("../settings.json", import.meta.url),
];
const settingsUrl = settingsUrls.find((url) => existsSync(url));

if (!settingsUrl) {
  throw new Error("settings.json was not found");
}

export const settings = JSON.parse(
  readFileSync(settingsUrl, "utf8"),
) as Settings;

if (!settings.github.username.trim()) {
  throw new Error("Set github.username in settings.json");
}
