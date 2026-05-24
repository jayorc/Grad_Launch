import { constants as fsConstants } from "node:fs";
import { access, appendFile } from "node:fs/promises";

// Normalizes labels, option text, URLs, and validation snippets into a stable
// lowercase key so fuzzy matching compares meaning instead of punctuation.
export function normalizeKey(value: string | undefined | null) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Removes duplicate field labels while preserving the first readable label for
// user-facing summaries, planner checkpoints, and debug logs.
export function dedupeLabels(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = normalizeKey(value);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

// Separates harmless dynamic status text from real validation failures. This
// prevents phrases like "loading" or "options available" from blocking form
// navigation as if they were required-field errors.
export function isTransientStatusMessage(value: string | undefined | null) {
  const normalized = normalizeKey(value);

  if (!normalized) {
    return false;
  }

  if (/\b(required|invalid|error|cannot be blank|please select|please enter|must be|failed|not allowed|denied)\b/.test(normalized)) {
    return false;
  }

  if (/\b(active loading indicator|loading|please wait|processing|uploading|saving|submitting|spinner|progress|still working|one moment)\b/.test(normalized)) {
    return true;
  }

  return /\b(options available|total results|use the up and down keys|press enter to select|press escape to exit|not selected|selected 1 of|selected \d+ of|results found|no results found)\b/.test(normalized);
}

// Parses a URL hostname defensively for ATS adapter checks and page-origin
// comparisons. Invalid URLs return an empty string instead of throwing.
export function safeHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

// Checks whether a local file or directory exists. Browser launch, resume
// upload, and storage setup all use this before touching paths.
export async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

// Extracts a JSON object from an LLM response. It accepts fenced JSON blocks
// first, then falls back to the first/last brace range for imperfect responses.
export function jsonBlock(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

// Appends one structured event to the run's browser-agent-debug.log. Logging is
// best-effort so a file-system problem never breaks the browser automation.
export async function writeBrowserDebug(workspacePath: string, label: string, payload: unknown) {
  try {
    await appendFile(
      `${workspacePath}/browser-agent-debug.log`,
      `${new Date().toISOString()} ${label} ${JSON.stringify(payload)}\n`,
      "utf-8"
    );
  } catch (_error) {
    // Best-effort debug trace only.
  }
}
