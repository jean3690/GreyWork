<script setup lang="ts">
import { shallowRef } from "vue";
import { useRouter } from "vue-router";
import { useUserAccountStore } from "@/stores/user-account";
import CloudUploadDialog from "./CloudUploadDialog.vue";
defineProps<{ root: string }>();
const open = shallowRef(false);
const account = useUserAccountStore();
const router = useRouter();
async function activate(): Promise<void> {
  await account.refresh();
  if (!account.session) {
    void router.push("/more/drive");
    return;
  }
  open.value = true;
}
</script>

<template>
  <button
    type="button"
    data-testid="workspace-cloud-upload"
    class="h-5 shrink-0 rounded-[calc(5px*var(--gw-radius-scale))] px-1.5 text-[10.5px] text-cyan hover:bg-cyan/15 focus-visible:outline-2 focus-visible:outline-cyan"
    :disabled="account.busy"
    @click="activate"
  >
    云存储
  </button>
  <CloudUploadDialog :open="open" :root="root" kind="file" @update:open="open = $event" />
</template>
