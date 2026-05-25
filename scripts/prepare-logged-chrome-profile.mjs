#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultDest = resolve(tmpdir(), "gradlaunch-runtime", "logged-browser-profile");

const sourceDir = resolveConfiguredPath(
  process.env.BROWSER_SOURCE_PROFILE_DIR || defaultChromeUserDataDir()
);
const destDir = resolveConfiguredPath(process.env.BROWSER_LOGGED_PROFILE_DIR || defaultDest);
const profileName = process.env.BROWSER_LOGGED_PROFILE_NAME?.trim() || await resolveChromeProfileName(sourceDir);

if (await isBrowserProfileLocked(sourceDir)) {
  console.error(`Chrome is still using ${sourceDir}. Quit Chrome completely, then run this command again.`);
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await copyIfPresent(resolve(sourceDir, "Local State"), resolve(destDir, "Local State"));
await copyIfPresent(resolve(sourceDir, "First Run"), resolve(destDir, "First Run"));

const sourceProfileDir = resolve(sourceDir, profileName);
const destProfileDir = resolve(destDir, profileName);
await cp(sourceProfileDir, destProfileDir, {
  recursive: true,
  force: true,
  filter: shouldCopyProfilePath
});

await writeFile(resolve(destDir, ".gradlaunch-profile-source.json"), JSON.stringify({
  copiedAt: new Date().toISOString(),
  sourceDir,
  profileName
}, null, 2));

console.log(`Prepared GradLaunch logged Chrome profile at ${destDir}`);
console.log(`Profile copied: ${profileName}`);
console.log(`Optional: set BROWSER_LOGGED_PROFILE_DIR=${destDir}`);
console.log(`Set BROWSER_LOGGED_PROFILE_NAME=${profileName}`);

function defaultChromeUserDataDir() {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return resolve(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data");
  }

  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "google-chrome");
}

function resolveConfiguredPath(value) {
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

async function resolveChromeProfileName(userDataDir) {
  try {
    const text = await readFile(resolve(userDataDir, "Local State"), "utf8");
    const localState = JSON.parse(text);
    const lastUsed = localState?.profile?.last_used;

    if (typeof lastUsed === "string" && lastUsed.trim()) {
      return lastUsed.trim();
    }

    const lastActiveProfiles = localState?.profile?.last_active_profiles;
    const firstActiveProfile = Array.isArray(lastActiveProfiles)
      ? lastActiveProfiles.find((item) => typeof item === "string" && item.trim())
      : undefined;

    if (firstActiveProfile) {
      return firstActiveProfile.trim();
    }
  } catch (_error) {
    // Fall through to Chrome's default profile directory.
  }

  return "Default";
}

async function isBrowserProfileLocked(userDataDir) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      await lstat(resolve(userDataDir, name));
      return true;
    } catch (_error) {
      // Missing singleton files mean this user-data-dir is not locked by Chrome.
    }
  }

  return false;
}

async function copyIfPresent(source, dest) {
  try {
    await cp(source, dest, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function shouldCopyProfilePath(source) {
  const name = basename(source);

  if (name.startsWith("Singleton")) {
    return false;
  }

  const ignoredNames = new Set([
    "Cache",
    "Code Cache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache"
  ]);

  if (ignoredNames.has(name)) {
    return false;
  }

  const parts = relative(sourceProfileDir, source).split(sep);
  return !parts.some((part) => ignoredNames.has(part));
}
