import type { AgentHandoffKind, FilledField, StudentMemory } from "@gradlaunch/shared";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";
import { AgentRepository } from "../repositories/agent-repository";

export class StudentMemoryService {
  constructor(private readonly repository = new AgentRepository()) {}

  async get(studentId: string): Promise<StudentMemory> {
    const existing = await this.repository.getStudentMemory(studentId);

    if (existing) {
      return existing;
    }

    const memory: StudentMemory = {
      studentId,
      successfulApplicationCount: 0,
      blockedSourceTypes: [],
      recentHandoffKinds: [],
      portalPatterns: [],
      corrections: [],
      notes: [`Memory initialized ${createId("memory_note")}.`],
      lastUpdatedAt: nowIso()
    };

    return this.repository.saveStudentMemory(memory);
  }

  async recordSubmissionOutcome(input: {
    studentId: string;
    sourceType?: string;
    success: boolean;
    note?: string;
  }) {
    const memory = await this.get(input.studentId);
    const next = {
      ...memory,
      successfulApplicationCount: input.success
        ? memory.successfulApplicationCount + 1
        : memory.successfulApplicationCount,
      blockedSourceTypes:
        input.success || !input.sourceType
          ? memory.blockedSourceTypes
          : dedupeValues([input.sourceType, ...memory.blockedSourceTypes]).slice(0, 10),
      notes: input.note ? [input.note, ...memory.notes].slice(0, 20) : memory.notes,
      lastUpdatedAt: nowIso()
    };

    return this.repository.saveStudentMemory(next);
  }

  async recordHandoff(studentId: string, kind: AgentHandoffKind, note?: string) {
    const memory = await this.get(studentId);
    const next = {
      ...memory,
      recentHandoffKinds: dedupeValues([kind, ...memory.recentHandoffKinds]).slice(0, 10) as AgentHandoffKind[],
      notes: note ? [note, ...memory.notes].slice(0, 20) : memory.notes,
      lastUpdatedAt: nowIso()
    };

    return this.repository.saveStudentMemory(next);
  }

  async recordCorrections(studentId: string, fields: FilledField[]) {
    if (fields.length === 0) {
      return this.get(studentId);
    }

    const memory = await this.get(studentId);
    const timestamp = nowIso();
    const correctionMap = new Map(memory.corrections.map((item) => [normalize(item.label), item]));

    for (const field of fields) {
      correctionMap.set(normalize(field.label), {
        label: field.label,
        value: field.value,
        updatedAt: timestamp
      });
    }

    return this.repository.saveStudentMemory({
      ...memory,
      corrections: [...correctionMap.values()].slice(0, 50),
      lastUpdatedAt: timestamp
    });
  }

  async recordPortalPattern(input: {
    studentId: string;
    domain: string;
    urlPattern?: string;
    fieldLabel: string;
    normalizedLabel?: string;
    autocomplete?: string;
    widgetKind?: string;
    valueKind?: string;
    domPathSignature?: string;
    strategy: string;
    queryMode?: "answer" | "first_token" | "typed_prefix";
    verificationEvidence?: string[];
    failureReason?: string;
    note?: string;
  }) {
    const memory = await this.get(input.studentId);
    const timestamp = nowIso();
    const key = [
      normalize(input.domain),
      normalize(input.normalizedLabel ?? input.fieldLabel),
      normalize(input.widgetKind ?? ""),
      normalize(input.valueKind ?? "")
    ].join("::");
    const patternMap = new Map(memory.portalPatterns.map((item) => {
      const itemKey = [
        normalize(item.domain),
        normalize(item.normalizedLabel ?? item.fieldLabel),
        normalize(item.widgetKind ?? ""),
        normalize(item.valueKind ?? "")
      ].join("::");
      return [itemKey, item] as const;
    }));
    const existing = patternMap.get(key);

    patternMap.set(key, {
      id: existing?.id ?? createId("portal_pattern"),
      domain: input.domain,
      urlPattern: input.urlPattern ?? existing?.urlPattern,
      fieldLabel: input.fieldLabel,
      normalizedLabel: input.normalizedLabel ?? existing?.normalizedLabel,
      autocomplete: input.autocomplete ?? existing?.autocomplete,
      widgetKind: input.widgetKind ?? existing?.widgetKind,
      valueKind: input.valueKind ?? existing?.valueKind,
      domPathSignature: input.domPathSignature ?? existing?.domPathSignature,
      strategy: input.strategy,
      queryMode: input.queryMode ?? existing?.queryMode,
      successCount: (existing?.successCount ?? 0) + 1,
      verificationEvidence: dedupeValues([...(input.verificationEvidence ?? []), ...(existing?.verificationEvidence ?? [])]).slice(0, 10),
      failureReason: input.failureReason ?? existing?.failureReason,
      notes: input.note ? dedupeValues([input.note, ...(existing?.notes ?? [])]).slice(0, 10) : existing?.notes ?? [],
      lastUsedAt: timestamp
    });

    return this.repository.saveStudentMemory({
      ...memory,
      portalPatterns: [...patternMap.values()].slice(0, 100),
      lastUpdatedAt: timestamp
    });
  }
}

function dedupeValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
