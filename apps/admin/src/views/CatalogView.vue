<script setup lang="ts">
import { Delete, Plus, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { adminApi } from "../api";
import { ApiError } from "../api/http";
import type { CatalogDetail, CatalogItemView } from "../types";
import { formatDateTime } from "../utils/format";

/**
 * 能力目录：控制面下发的技能与 MCP 预设。
 *
 * 编辑用 JSON 直编而不是逐字段表单：技能正文本来就是「若干文件 + 一段 Markdown」，
 * 拆成表单控件反而更难看清装到用户机器上的到底是什么。校验仍在后端（与宿主落盘规则同口径），
 * 这里只挡住「不是合法 JSON」这种立刻能发现的问题。
 */
const items = ref<CatalogItemView[]>([]);
const loading = ref(false);
const kind = ref<"all" | "skill" | "mcp">("all");

const dialogOpen = ref(false);
const editing = ref<{ id: string | null; kind: "skill" | "mcp" } | null>(null);
const draft = ref("");
const saving = ref(false);

const dialogTitle = computed(() => {
  if (!editing.value) return "";
  const label = editing.value.kind === "skill" ? "技能" : "MCP 预设";
  return (editing.value.id === null ? "新建" : "编辑") + label;
});

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = await adminApi.catalog(kind.value);
  } catch (err) {
    ElMessage.error(messageOf(err, "目录加载失败"));
  } finally {
    loading.value = false;
  }
}

const SKILL_TEMPLATE = {
  ref: "greywork/skills/my-skill",
  skillId: "my-skill",
  name: "我的技能",
  description: "一句话说明这个技能解决什么问题",
  installs: 0,
  enabled: true,
  files: [
    {
      path: "SKILL.md",
      contents: "---\nname: my-skill\ndescription: 一句话说明这个技能解决什么问题\n---\n\n# 我的技能\n",
    },
  ],
};

const MCP_TEMPLATE = {
  name: "io.example/server",
  title: "示例服务",
  description: "这条预设会在桌面端「登记」成本机 MCP 服务器",
  version: "0.1.0",
  repositoryUrl: "https://github.com/example/repo",
  registryType: "npm",
  identifier: "@example/mcp-server",
  packageVersion: "latest",
  envNames: [],
  enabled: true,
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function openCreate(target: "skill" | "mcp"): void {
  editing.value = { id: null, kind: target };
  draft.value = pretty(target === "skill" ? SKILL_TEMPLATE : MCP_TEMPLATE);
  dialogOpen.value = true;
}

async function openEdit(row: CatalogItemView): Promise<void> {
  try {
    const detail: CatalogDetail = await adminApi.catalogDetail(row.id);
    editing.value = { id: row.id, kind: row.kind };
    draft.value = pretty(
      row.kind === "skill"
        ? {
            ref: detail.item.ref,
            skillId: detail.item.slug,
            name: detail.item.name,
            description: detail.item.description ?? "",
            installs: detail.item.installs,
            enabled: detail.item.enabled,
            files: detail.files ?? [],
          }
        : {
            name: detail.item.ref,
            title: detail.item.title ?? "",
            description: detail.item.description ?? "",
            version: detail.mcp?.version ?? "",
            repositoryUrl: detail.mcp?.repository?.url ?? "",
            registryType: detail.mcp?.packages?.[0]?.registryType ?? "npm",
            identifier: detail.mcp?.packages?.[0]?.identifier ?? "",
            packageVersion: detail.mcp?.packages?.[0]?.version ?? "latest",
            envNames: (detail.mcp?.packages?.[0]?.environmentVariables ?? []).map((env) => env.name),
            enabled: detail.item.enabled,
          },
    );
    dialogOpen.value = true;
  } catch (err) {
    ElMessage.error(messageOf(err, "条目详情加载失败"));
  }
}

async function save(): Promise<void> {
  if (!editing.value) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(draft.value) as Record<string, unknown>;
  } catch (err) {
    ElMessage.error("JSON 解析失败：" + (err instanceof Error ? err.message : String(err)));
    return;
  }
  saving.value = true;
  try {
    const target = editing.value;
    if (target.kind === "skill") {
      if (target.id === null) await adminApi.createCatalogSkill(payload);
      else await adminApi.updateCatalogSkill(target.id, payload);
    } else if (target.id === null) {
      await adminApi.createCatalogMcp(payload);
    } else {
      await adminApi.updateCatalogMcp(target.id, payload);
    }
    ElMessage.success("已保存，桌面端下一次搜索就能看到");
    dialogOpen.value = false;
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "保存失败"));
  } finally {
    saving.value = false;
  }
}

async function toggle(row: CatalogItemView, enabled: boolean): Promise<void> {
  try {
    await adminApi.setCatalogEnabled(row.id, enabled);
    row.enabled = enabled;
    ElMessage.success(enabled ? "已上架" : "已下架（桌面端搜不到，已装的不受影响）");
  } catch (err) {
    ElMessage.error(messageOf(err, "状态更新失败"));
    await load();
  }
}

async function remove(row: CatalogItemView): Promise<void> {
  try {
    await ElMessageBox.confirm("删除后桌面端搜不到这条目录；已经装到用户机器上的内容不会被卸载。", "删除条目", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await adminApi.deleteCatalog(row.id);
    ElMessage.success("已删除");
    await load();
  } catch (err) {
    ElMessage.error(messageOf(err, "删除失败"));
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <section class="gw-card">
      <header>
        <h3>能力目录</h3>
        <span class="gw-dim">桌面端在「技能源」/「MCP Registry」里填控制面地址即可安装</span>
      </header>
      <div class="gw-toolbar">
        <el-radio-group v-model="kind" size="small" data-testid="catalog-kind" @change="load">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="skill">技能</el-radio-button>
          <el-radio-button value="mcp">MCP</el-radio-button>
        </el-radio-group>
        <el-button type="primary" :icon="Plus" data-testid="catalog-create-skill" @click="openCreate('skill')"> 新建技能 </el-button>
        <el-button :icon="Plus" data-testid="catalog-create-mcp" @click="openCreate('mcp')">新建 MCP</el-button>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <span class="spacer" />
        <span class="gw-dim">共 {{ items.length }} 条</span>
      </div>

      <el-table v-loading="loading" :data="items" empty-text="目录是空的：新建一条，或重启后端从内置 JSON 播种">
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.kind === 'skill' ? 'success' : 'warning'">
              {{ row.kind === "skill" ? "技能" : "MCP" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <div class="cell-main">{{ row.title || row.name }}</div>
            <div class="gw-dim cell-sub">{{ row.description || "—" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="引用 / 包" min-width="230">
          <template #default="{ row }">
            <span class="gw-mono">{{ row.ref }}</span>
            <div class="gw-dim cell-sub">{{ row.kind === "skill" ? row.fileCount + " 个文件" : row.packageLabel || "—" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="安装量" width="90">
          <template #default="{ row }">
            <span class="gw-dim">{{ row.kind === "skill" ? row.installs : "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上架" width="90">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              size="small"
              :data-testid="`catalog-enabled-${row.id}`"
              @change="(value: string | number | boolean) => toggle(row, Boolean(value))"
            />
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span class="gw-dim">{{ formatDateTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="dialogOpen" :title="dialogTitle" width="720px" destroy-on-close>
      <p class="gw-dim dialog-hint">
        校验规则与宿主落盘一致：技能 id 必须是小写 slug，文件为相对路径、单文件 ≤256KB、必须有
        <code>SKILL.md</code>；MCP 只支持 npm / pypi 两种包类型。
      </p>
      <el-input v-model="draft" type="textarea" :rows="20" spellcheck="false" data-testid="catalog-draft" class="draft" />
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" data-testid="catalog-save" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cell-main {
  font-size: 13px;
  color: var(--gw-text);
}

.cell-sub {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
}

.dialog-hint {
  margin: 0 0 10px;
  font-size: 11.5px;
  line-height: 1.7;
}

.dialog-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(88, 166, 255, 0.12);
  color: var(--gw-accent);
}

.draft :deep(textarea) {
  font-family: var(--gw-mono-font, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.6;
}
</style>
