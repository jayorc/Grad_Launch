export type DataMode = "mongo" | "memory";
export type RequestedDataMode = DataMode | "auto";

let activeDataMode: DataMode = "mongo";

export function getActiveDataMode() {
  return activeDataMode;
}

export function setActiveDataMode(mode: DataMode) {
  activeDataMode = mode;
}

export function isMemoryMode() {
  return activeDataMode === "memory";
}
