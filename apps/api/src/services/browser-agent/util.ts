import { constants as fsConstants } from "node:fs";
import { access, appendFile } from "node:fs/promises";

export function normalizeKey(value: string | undefined | null) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

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

export function safeHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

export async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

export function jsonBlock(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

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
