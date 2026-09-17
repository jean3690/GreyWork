<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { sortUiRegions } from "@/lib/ui-regions";
import { useCapabilityLoader } from "@/plugins/current";

const EDGE_GAP = 12;
const DEFAULT_BOTTOM = 24;
const DEFAULT_RIGHT = 24;

const regions = computed(() =>
  sortUiRegions(
    useCapabilityLoader()
      .snapshot()
      .uiRegions.filter((region) => region.region === "workspaceOverlay"),
  ),
);

const positions = ref<Record<string, { left: number; top: number }>>({});
const regionElements = new Map<string, HTMLElement>();

function storageKey(id: string): string {
  return `greywork:overlay-position:${id}`;
}

function clampPosition(left: number, top: number, element: HTMLElement): { left: number; top: number } {
  const maxLeft = Math.max(EDGE_GAP, window.innerWidth - element.offsetWidth - EDGE_GAP);
  const maxTop = Math.max(EDGE_GAP, window.innerHeight - element.offsetHeight - EDGE_GAP);
  return {
    left: Math.min(Math.max(left, EDGE_GAP), maxLeft),
    top: Math.min(Math.max(top, EDGE_GAP), maxTop),
  };
}

function initialPosition(id: string, element: HTMLElement): { left: number; top: number } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(id)) ?? "null") as unknown;
    if (
      saved &&
      typeof saved === "object" &&
      typeof (saved as { left?: unknown }).left === "number" &&
      typeof (saved as { top?: unknown }).top === "number"
    ) {
      return clampPosition((saved as { left: number }).left, (saved as { top: number }).top, element);
    }
  } catch {
    // 损坏的位置记录直接回退默认位置。
  }
  return clampPosition(
    window.innerWidth - element.offsetWidth - DEFAULT_RIGHT,
    window.innerHeight - element.offsetHeight - DEFAULT_BOTTOM,
    element,
  );
}

function setRegionElement(id: string, value: unknown): void {
  if (!(value instanceof HTMLElement)) {
    regionElements.delete(id);
    return;
  }
  regionElements.set(id, value);
  if (!positions.value[id]) positions.value[id] = initialPosition(id, value);
}

function startDrag(id: string, event: PointerEvent): void {
  if (event.button !== 0) return;
  const element = regionElements.get(id);
  if (!element) return;
  const origin = positions.value[id] ?? initialPosition(id, element);
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;

  element.setPointerCapture?.(pointerId);
  document.body.style.userSelect = "none";

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    positions.value[id] = clampPosition(origin.left + moveEvent.clientX - startX, origin.top + moveEvent.clientY - startY, element);
  };
  const finish = (upEvent: PointerEvent): void => {
    if (upEvent.pointerId !== pointerId) return;
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", finish);
    document.body.style.userSelect = "";
    const position = positions.value[id];
    if (position) window.localStorage.setItem(storageKey(id), JSON.stringify(position));
  };

  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}

function keepInsideViewport(): void {
  for (const [id, element] of regionElements) {
    const current = positions.value[id];
    if (current) positions.value[id] = clampPosition(current.left, current.top, element);
  }
}

onMounted(() => {
  window.addEventListener("resize", keepInsideViewport);
  void nextTick(keepInsideViewport);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", keepInsideViewport);
  document.body.style.userSelect = "";
});
</script>

<template>
  <div class="pointer-events-none fixed inset-0 z-40" data-testid="workspace-overlay-regions">
    <section
      v-for="region in regions"
      :key="region.id"
      :ref="(value) => setRegionElement(region.id, value)"
      class="pointer-events-auto fixed overflow-hidden rounded-xl border border-line bg-panel/95 shadow-xl backdrop-blur"
      :style="
        positions[region.id] ? { left: `${positions[region.id]!.left}px`, top: `${positions[region.id]!.top}px` } : { visibility: 'hidden' }
      "
      :data-testid="`workspace-overlay-${region.id}`"
    >
      <header
        class="flex h-7 cursor-move touch-none items-center justify-between border-b border-line-2 px-2 text-[10px] font-medium text-dim2"
        :data-testid="`workspace-overlay-handle-${region.id}`"
        @pointerdown="startDrag(region.id, $event)"
      >
        <span>{{ region.title }}</span>
        <span aria-hidden="true" class="tracking-[2px] opacity-50">•••</span>
      </header>
      <div class="p-2">
        <component :is="region.component" :key="region.id" />
      </div>
    </section>
  </div>
</template>
