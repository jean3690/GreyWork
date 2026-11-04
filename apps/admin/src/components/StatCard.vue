<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    value: string;
    hint?: string;
    tone?: "blue" | "mint" | "amber" | "violet" | "red";
  }>(),
  { hint: "", tone: "blue" },
);
</script>

<template>
  <div class="stat-card" :data-tone="tone">
    <div class="stat-top">
      <span class="stat-label">{{ label }}</span>
      <span class="stat-icon"><slot name="icon" /></span>
    </div>
    <div class="stat-value">{{ value }}</div>
    <div v-if="hint" class="stat-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat-card {
  position: relative;
  overflow: hidden;
  padding: 15px 16px 14px;
  background: linear-gradient(160deg, #171d25, #131920 70%);
  border: 1px solid var(--gw-line);
  border-radius: 12px;
}

.stat-card::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  background: var(--tone);
  opacity: 0.85;
}

.stat-card[data-tone="blue"] {
  --tone: var(--gw-accent);
}
.stat-card[data-tone="mint"] {
  --tone: var(--gw-mint);
}
.stat-card[data-tone="amber"] {
  --tone: var(--gw-amber);
}
.stat-card[data-tone="violet"] {
  --tone: var(--gw-violet);
}
.stat-card[data-tone="red"] {
  --tone: var(--gw-red);
}

.stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--gw-dim);
  font-size: 12px;
}

.stat-icon {
  color: var(--tone);
  display: inline-flex;
  font-size: 15px;
  opacity: 0.9;
}

.stat-value {
  margin-top: 8px;
  font-size: 26px;
  line-height: 1.1;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat-hint {
  margin-top: 7px;
  color: var(--gw-dim);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
