<script setup lang="ts">
/**
 * 3D 模型预览：glb / gltf 走 three.js + OrbitControls。
 *
 * 数据走媒体通道的 **bytes** 偏好：模型必须整份拿到才能交给 GLTFLoader 解析
 * （视频那套 Range 流式地址在这里没有用武之地）。额度 64MB，见 viewer.ts 的 MEDIA_LIMITS。
 *
 * glTF 允许引用同目录的外部 .bin / 贴图，而预览只拿到单个文件路径 —— 那类模型解析必然
 * 失败，此时给出明确提示让用户导出 .glb，而不是留一个空场景让人以为模型是空的。
 *
 * 资源释放是这里最容易漏的地方：切一次 tab 就换一份几何 / 材质 / WebGL 上下文，
 * 不 dispose 就是显存泄漏。所以「换内容」与「卸载」都走同一条 teardown。
 *
 * 画布容器（`stage`）**不随加载态出现/消失**：`data` 的 watch 跑在 Vue 的 pre-flush 阶段，
 * 早于组件重渲染 —— 若把 stage 放进 `v-else` 分支，回调里读到的仍是 null，renderer 建不出来，
 * 而等 stage 真正挂上时又没有任何东西会再触发一次解析（症状是永远空白）。所以只有「读取失败」
 * 才拆掉 stage，加载中用一个覆盖层提示。
 */
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { extname } from "@greywork/core";
import Icon from "@/features/shared/Icon.vue";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { usePreviewMedia } from "@/lib/preview-content";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const t = i18n.global.t;

const { data, loading, error } = usePreviewMedia(toRef(props, "tab"), "bytes");

const stage = ref<HTMLElement | null>(null);
/** 解析失败（含「引用外部资源」这类 glTF 特有问题），与读取失败分开显示。 */
const parseError = ref<string | null>(null);
const stats = ref({ meshes: 0, triangles: 0 });
const autoRotate = ref(true);
const ready = computed(() => parseError.value === null && error.value === null);

/**
 * three 的对象**刻意不放 ref**：它们是几百个内部字段的可变对象，被 Vue 的深层代理
 * 包一层既无意义（UI 不读它们）又拖慢渲染循环。
 */
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let controls: OrbitControls | null = null;
let content: THREE.Object3D | null = null;
let loop = 0;
let observer: ResizeObserver | null = null;

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      // 材质上的贴图也要显式释放：材质 dispose 不会连带释放它们。
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value && typeof value === "object" && "isTexture" in value) (value as THREE.Texture).dispose();
      }
      material.dispose();
    }
  });
}

/** 拆掉当前模型（保留 renderer / scene / camera，它们跨文件复用）。 */
function clearContent(): void {
  if (content && scene) {
    scene.remove(content);
    disposeObject(content);
  }
  content = null;
  stats.value = { meshes: 0, triangles: 0 };
}

/** 惰性建 renderer：只在 stage 就绪后建，避免挂载前拿到 null 容器。 */
function ensureRenderer(): boolean {
  if (renderer) return true;
  const host = stage.value;
  if (!host) return false;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (cause) {
    // 没有 WebGL（老显卡 / 驱动被禁）时给一句话，而不是抛到控制台后白屏。
    parseError.value = cause instanceof Error ? cause.message : String(cause);
    return false;
  }
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(host.clientWidth || 1, host.clientHeight || 1);
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, (host.clientWidth || 1) / (host.clientHeight || 1), 0.01, 100000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 1.2;

  // 半球光给环境色，平行光给形体 —— 只有环境光时模型会糊成一片。
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-4, -2, -3);
  scene.add(fill);
  return true;
}

function measure(root: THREE.Object3D): { meshes: number; triangles: number } {
  let meshes = 0;
  let triangles = 0;
  root.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (!geometry) return;
    meshes += 1;
    const index = geometry.getIndex();
    const position = geometry.getAttribute("position");
    triangles += (index ? index.count : (position?.count ?? 0)) / 3;
  });
  return { meshes, triangles: Math.floor(triangles) };
}

/** 把相机摆到「整个模型刚好装下」的位置，并把控制器目标移到模型中心。 */
function frameContent(): void {
  if (!content || !camera || !controls) return;
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(center.x + distance * 0.9, center.y + distance * 0.7, center.z + distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function parseGltf(buffer: ArrayBuffer): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      // resourcePath 留空：预览只拿到这一个文件，外部相对引用无处可寻，
      // 解析失败时由调用方翻成人话（见 load 的 catch）。
      "",
      (gltf) => resolve(gltf.scene as THREE.Object3D),
      (cause: unknown) => reject(cause instanceof Error ? cause : new Error(String(cause))),
    );
  });
}

async function load(bytes: Uint8Array): Promise<void> {
  parseError.value = null;
  if (!ensureRenderer() || !scene) return;
  clearContent();
  // 复制成独立的 ArrayBuffer：GLTFLoader 会持有它，而 bytes 可能指向一个更大的池。
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const object = await parseGltf(buffer);
    content = object;
    scene.add(object);
    stats.value = measure(object);
    frameContent();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const ext = extname(props.tab.path).toLowerCase();
    // .gltf 引用外部 .bin / 贴图是最常见的失败原因，直接把出路写进错误里。
    parseError.value = ext === "gltf" ? t("preview.model.externalRefs", { detail }) : detail;
  }
}

function startLoop(): void {
  const tick = (): void => {
    loop = requestAnimationFrame(tick);
    if (controls) {
      controls.autoRotate = autoRotate.value;
      controls.update();
    }
    if (renderer && scene && camera) renderer.render(scene, camera);
  };
  loop = requestAnimationFrame(tick);
}

function resize(): void {
  const host = stage.value;
  if (!host || !renderer || !camera) return;
  const width = host.clientWidth || 1;
  const height = host.clientHeight || 1;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

watch(data, (source) => {
  const bytes = source?.kind === "bytes" ? source.bytes : null;
  if (!bytes) {
    parseError.value = null;
    clearContent();
    return;
  }
  void load(bytes);
});

onMounted(() => {
  startLoop();
  if (typeof ResizeObserver !== "undefined" && stage.value) {
    observer = new ResizeObserver(() => resize());
    observer.observe(stage.value);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(loop);
  observer?.disconnect();
  observer = null;
  clearContent();
  controls?.dispose();
  controls = null;
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
  scene = null;
  camera = null;
});

const toolButtonClass =
  "grid h-6 shrink-0 cursor-pointer place-items-center rounded-[calc(6px*var(--gw-radius-scale))] px-2 text-[11px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan";
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
      <span v-if="ready && stats.meshes" class="shrink-0 tabular-nums" data-testid="model-stats">
        {{ t("preview.model.stats", { meshes: stats.meshes, triangles: stats.triangles }) }}
      </span>
      <button type="button" data-testid="model-reset" :class="toolButtonClass" @click="frameContent()">
        <Icon name="rotate-right" :size="12" />
      </button>
      <button
        type="button"
        data-testid="model-auto-rotate"
        :class="toolButtonClass"
        :aria-pressed="autoRotate"
        @click="autoRotate = !autoRotate"
      >
        {{ t("preview.model.autoRotate") }}
      </button>
    </div>

    <div v-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else class="relative min-h-0 flex-1">
      <div ref="stage" data-testid="model-stage" class="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" />
      <p v-if="loading" class="pointer-events-none absolute inset-0 grid place-items-center px-4 text-[12px] text-dim2">
        {{ t("preview.common.loading") }}
      </p>
      <div
        v-if="parseError"
        role="alert"
        class="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-panel/95 px-4 py-2"
      >
        <span class="min-w-0 flex-1 text-[11.5px] text-orange">{{ t("preview.model.parseFailed", { detail: parseError }) }}</span>
        <PreviewExternalButton :tab="tab" />
      </div>
    </div>
  </div>
</template>
