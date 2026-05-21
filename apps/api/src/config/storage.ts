import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "../../../../");

export function getResumeStorageDir() {
  return process.env.RESUME_STORAGE_DIR
    ? resolve(projectRoot, process.env.RESUME_STORAGE_DIR)
    : resolve(projectRoot, "storage", "resumes");
}

export function getApplicationArtifactStorageDir() {
  return process.env.APPLICATION_ARTIFACT_STORAGE_DIR
    ? resolve(projectRoot, process.env.APPLICATION_ARTIFACT_STORAGE_DIR)
    : resolve(projectRoot, "storage", "applications");
}

export function getEmailOutboxStorageDir() {
  return process.env.EMAIL_OUTBOX_DIR
    ? resolve(projectRoot, process.env.EMAIL_OUTBOX_DIR)
    : resolve(projectRoot, "storage", "email-outbox");
}

export function getBrowserProfileStorageDir() {
  return process.env.BROWSER_PROFILE_DIR
    ? resolve(projectRoot, process.env.BROWSER_PROFILE_DIR)
    : resolve(projectRoot, "storage", "browser-profile");
}
