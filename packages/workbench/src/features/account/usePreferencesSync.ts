import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { cloudRequest, cloudError } from "@/lib/cloud-api";
import {
  parsePreferencesSnapshot,
  parsePublicPreferences,
  parseSyncRevision,
  preferencesAccountKey,
  preferencesFingerprint,
  publicPreferencesOf,
  type PreferencesBaseline,
  type PreferencesSnapshot,
} from "@/lib/preferences-sync";
import { useSettingsStore } from "@/stores/settings";
import { useUserAccountStore } from "@/stores/user-account";

export function usePreferencesSync() {
  const account = useUserAccountStore();
  const settings = useSettingsStore();
  const accountKey = computed(() => preferencesAccountKey(account.status?.baseUrl, account.session?.user.id));
  const identity = computed(() => `${accountKey.value ?? ""}:${account.session?.device.id ?? ""}`);
  const ready = computed(() => account.available && !!account.session && !!accountKey.value);
  const local = computed(() => publicPreferencesOf(settings));
  const fingerprint = computed(() => preferencesFingerprint(local.value));
  const baseline = shallowRef<PreferencesBaseline | null>(null);
  const remote = shallowRef<PreferencesSnapshot | null>(null);
  const busy = shallowRef(false);
  const error = shallowRef("");
  const notice = shallowRef("");
  const conflict = shallowRef(false);
  const dirty = computed(() => !baseline.value || preferencesFingerprint(baseline.value.payload) !== fingerprint.value);
  const remoteChanged = computed(() => !!remote.value && remote.value.revision !== (baseline.value?.revision ?? null));
  let revision = 0;
  const path = "/api/sync/preferences";

  function loadBaseline(key: string | null): void {
    baseline.value = null;
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const value = JSON.parse(raw) as PreferencesBaseline;
      const version = parseSyncRevision(value.revision);
      if (version !== null) baseline.value = { revision: version, payload: parsePublicPreferences(value.payload) };
    } catch {
      /* 损坏的基线按首次同步处理，CAS 仍会阻止覆盖已有云端数据。 */
    }
  }
  function acknowledge(key: string, value: PreferencesBaseline): void {
    baseline.value = value;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      error.value = "同步已完成，但本机无法保存版本基线；重启后请重新检查云端。";
    }
  }
  watch(
    identity,
    () => {
      revision += 1;
      busy.value = false;
      remote.value = null;
      error.value = "";
      notice.value = "";
      conflict.value = false;
      loadBaseline(accountKey.value);
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    revision += 1;
  });

  async function latest(): Promise<PreferencesSnapshot> {
    return parsePreferencesSnapshot(await cloudRequest("GET", path));
  }
  async function operation(run: (current: () => boolean, key: string) => Promise<void>): Promise<void> {
    if (!ready.value || busy.value || !accountKey.value) return;
    const key = accountKey.value;
    const stamp = identity.value;
    const ticket = ++revision;
    const current = () => ticket === revision && identity.value === stamp && ready.value;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
      await settings.hydrated;
      if (current()) await run(current, key);
    } catch (cause) {
      if (current()) error.value = cloudError(cause);
    } finally {
      if (current()) busy.value = false;
    }
  }
  const inspect = (): Promise<void> =>
    operation(async (current) => {
      remote.value = null;
      const value = await latest();
      if (!current()) return;
      remote.value = value;
      conflict.value = false;
      notice.value = value.deleted
        ? "云端偏好已删除，本机设置仍保留。"
        : value.payload
          ? "已读取云端偏好，尚未修改本机设置。"
          : "云端尚未保存偏好，可推送本机设置。";
    });

  function pushWithRevision(expected?: PreferencesSnapshot, expectedLocal?: string): Promise<void> {
    return operation(async (current, key) => {
      if (expectedLocal !== undefined && expectedLocal !== fingerprint.value) throw new Error("本机偏好已变化，请重新确认后再推送");
      const sent = parsePublicPreferences(local.value);
      const baseRevision = expected === undefined ? (baseline.value?.revision ?? null) : expected.revision;
      try {
        const raw = await cloudRequest<{ revision: unknown }>("PUT", path, { baseRevision, payload: sent });
        if (!current()) return;
        const version = parseSyncRevision(raw.revision);
        if (version === null) throw new Error("Java 后端未返回同步版本号");
        acknowledge(key, { revision: version, payload: sent });
        remote.value = { revision: version, deleted: false, payload: sent };
        conflict.value = false;
        notice.value =
          preferencesFingerprint(sent) === fingerprint.value ? "本机偏好已推送到云端。" : "已推送请求开始时的偏好；期间的新修改仍待同步。";
      } catch (cause) {
        if (!current()) return;
        if (!/HTTP 409\b/.test(cloudError(cause))) throw cause;
        conflict.value = true;
        remote.value = null;
        const value = await latest();
        if (!current()) return;
        remote.value = value;
        error.value = "云端已被其他设备修改。未覆盖任何设置，请选择使用云端，或确认保留本机后重新推送。";
      }
    });
  }
  const pushLocal = (): Promise<void> => pushWithRevision();
  const keepLocal = (snapshot: PreferencesSnapshot, localFingerprint: string): Promise<void> =>
    pushWithRevision(snapshot, localFingerprint);
  const useCloud = (expected: PreferencesSnapshot, expectedLocal: string): Promise<void> =>
    operation(async (current, key) => {
      if (expectedLocal !== fingerprint.value) throw new Error("本机偏好已变化，请重新确认云端应用操作");
      remote.value = null;
      const value = await latest();
      if (!current()) return;
      remote.value = value;
      if (value.revision !== expected.revision || JSON.stringify(value.payload) !== JSON.stringify(expected.payload)) {
        throw new Error("云端又有更新，请检查最新内容并重新确认");
      }
      if (!value.payload || value.revision === null) throw new Error("云端没有可应用的偏好，本机设置保持不变");
      if (expectedLocal !== fingerprint.value) throw new Error("本机偏好已变化，请重新确认云端应用操作");
      settings.applySyncedPreferences(value.payload);
      acknowledge(key, { revision: value.revision, payload: value.payload });
      conflict.value = false;
      notice.value = "云端显示偏好已应用；本机路径、权限、密钥和模型/MCP 配置未改变。";
    });
  return {
    ready,
    identity,
    local,
    fingerprint,
    baseline,
    remote,
    busy,
    error,
    notice,
    conflict,
    dirty,
    remoteChanged,
    inspect,
    pushLocal,
    keepLocal,
    useCloud,
  };
}
