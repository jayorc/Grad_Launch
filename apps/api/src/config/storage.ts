import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../../../../");

export function getResumeStorageDir() {
  return process.env.RESUME_STORAGE_DIR
    ? resolveConfiguredPath(process.env.RESUME_STORAGE_DIR)
    : resolve(projectRoot, "storage", "resumes");
}

export function getApplicationArtifactStorageDir() {
  return process.env.APPLICATION_ARTIFACT_STORAGE_DIR
    ? resolveConfiguredPath(process.env.APPLICATION_ARTIFACT_STORAGE_DIR)
    : resolve(projectRoot, "storage", "applications");
}

export function getEmailOutboxStorageDir() {
  return process.env.EMAIL_OUTBOX_DIR
    ? resolveConfiguredPath(process.env.EMAIL_OUTBOX_DIR)
    : resolve(projectRoot, "storage", "email-outbox");
}

export function getBrowserWorkspaceStorageDir() {
  return process.env.BROWSER_WORKSPACE_DIR
    ? resolveConfiguredPath(process.env.BROWSER_WORKSPACE_DIR)
    : resolve(projectRoot, "storage", "browser");
}

export function getManagedBrowserProfileDir() {
  return process.env.BROWSER_PROFILE_DIR
    ? resolveConfiguredPath(process.env.BROWSER_PROFILE_DIR)
    : resolve(projectRoot, "storage", "browser-profile");
}

export function getLoggedBrowserProfileDir() {
  if (process.env.BROWSER_LOGGED_PROFILE_DIR?.trim()) {
    return resolveConfiguredPath(process.env.BROWSER_LOGGED_PROFILE_DIR);
  }

  if (process.env.BROWSER_PREFER_LOGGED_PROFILE === "false") {
    return undefined;
  }

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

  return resolve(projectRoot, trimmed);
}
