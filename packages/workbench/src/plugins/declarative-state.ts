import { createJsonStorage } from "@greywork/core";
import { reactive } from "vue";
import type { DeclarativeAction, DeclarativeField, DeclarativeValue } from "./market-types";

type PluginState = Record<string, DeclarativeValue>;
type StateArchive = Record<string, PluginState>;

const storage = createJsonStorage<StateArchive>(
  "greywork.plugins.declarativeState",
  (value): value is StateArchive =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        Object.values(item).every((entry) => ["string", "number", "boolean"].includes(typeof entry)),
    ),
);

const archive = reactive<StateArchive>(storage.read() ?? {});

function defaultsFor(fields: readonly DeclarativeField[]): PluginState {
  return Object.fromEntries(fields.map((field) => [field.key, field.default]));
}

function persist(): void {
  storage.write(Object.fromEntries(Object.entries(archive).map(([id, state]) => [id, { ...state }])));
}

export function useDeclarativePluginState(stateId: string, fields: readonly DeclarativeField[]): PluginState {
  const defaults = defaultsFor(fields);
  const state = archive[stateId] ?? reactive<PluginState>({ ...defaults });
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in state)) state[key] = value;
  }
  archive[stateId] = state;
  return state;
}

export function setDeclarativePluginValue(stateId: string, state: PluginState, key: string, value: DeclarativeValue): void {
  state[key] = value;
  archive[stateId] = state;
  persist();
}

export function runDeclarativeAction(
  stateId: string,
  state: PluginState,
  fields: readonly DeclarativeField[],
  action: DeclarativeAction,
): void {
  const operation = action.operation;
  if (operation.type === "reset") {
    Object.assign(state, defaultsFor(fields));
  } else if (operation.type === "set") {
    state[operation.key] = operation.value;
  } else if (operation.type === "increment") {
    const current = state[operation.key];
    if (typeof current !== "number") return;
    const field = fields.find((candidate) => candidate.key === operation.key);
    const next = current + (operation.amount ?? 1);
    state[operation.key] = Math.min(field?.max ?? Number.POSITIVE_INFINITY, Math.max(field?.min ?? Number.NEGATIVE_INFINITY, next));
  } else {
    return;
  }
  archive[stateId] = state;
  persist();
}

export function clearDeclarativePluginState(pluginId: string): void {
  for (const id of Object.keys(archive)) {
    if (id === pluginId || id.startsWith(`${pluginId}/`)) delete archive[id];
  }
  persist();
}
