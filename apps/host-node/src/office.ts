/**
 * Office 集成的宿主侧事实查询。
 * 移植 `services/office/mod.rs::host_info` —— 只回「变量名是否已设置」，不回值。
 */
export function hostInfo(
  embeddableFrameOrigins: string[],
  envNames: string[],
): { embeddableFrameOrigins: string[]; envPresent: string[]; envMissing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of envNames) {
    const trimmed = name.trim();
    if (trimmed === "") continue;
    if (process.env[trimmed]) present.push(trimmed);
    else missing.push(trimmed);
  }
  return { embeddableFrameOrigins, envPresent: present, envMissing: missing };
}
