import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../../../../");
const runtimeRoot = resolve(tmpdir(), "gradlaunch-runtime");

export function getResumeStorageDir() {
  return process.env.RESUME_STORAGE_DIR
    ? resolveConfiguredPath(process.env.RESUME_STORAGE_DIR)
    : resolve(runtimeRoot, "resumes");
}

export function getEmailOutboxStorageDir() {
  return process.env.EMAIL_OUTBOX_DIR
    ? resolveConfiguredPath(process.env.EMAIL_OUTBOX_DIR)
    : resolve(runtimeRoot, "email-outbox");
}

export function getBrowserWorkspaceStorageDir() {
  return process.env.BROWSER_WORKSPACE_DIR
    ? resolveConfiguredPath(process.env.BROWSER_WORKSPACE_DIR)
    : resolve(runtimeRoot, "browser");
}

export function getManagedBrowserProfileDir() {
  return process.env.BROWSER_PROFILE_DIR
    ? resolveConfiguredPath(process.env.BROWSER_PROFILE_DIR)
    : resolve(runtimeRoot, "browser-profile");
}

export function getLoggedBrowserProfileDir() {
  if (process.env.BROWSER_LOGGED_PROFILE_DIR?.trim()) {
    return resolveConfiguredPath(process.env.BROWSER_LOGGED_PROFILE_DIR);
  }

  if (process.env.BROWSER_PREFER_LOGGED_PROFILE === "false") {
    return undefined;
  }

  if (process.env.BROWSER_USE_SYSTEM_CHROME_PROFILE !== "true") {
    return resolve(runtimeRoot, "logged-browser-profile");
  }

  return getSystemChromeUserDataDir();
}

function getSystemChromeUserDataDir() {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return resolve(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data");
  }

  const linuxConfigRoot = process.env.XDG_CONFIG_HOME
    ? resolveConfiguredPath(process.env.XDG_CONFIG_HOME)
    : resolve(homedir(), ".config");
  return resolve(linuxConfigRoot, "google-chrome");
}

function resolveConfiguredPath(value: string) {
  const trimmed = value.trim();

  if (trimmed === "~") {
    return homedir();
  }

  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }

  if (isAbsolute(trimmed)) {
    return trimmed;
  }

  return resolve(projectRoot, trimmed);
}
