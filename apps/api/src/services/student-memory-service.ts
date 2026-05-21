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
}

function dedupeValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
