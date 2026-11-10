<script setup>
// One alert style for the whole app: soft tinted box, matching icon, optional close button.
const props = defineProps({
  tone: { type: String, default: 'info' },
  dismissible: { type: Boolean, default: true },
});
defineEmits(['close']);
const icons = {
  info: 'info-circle-fill',
  success: 'check-circle-fill',
  warning: 'exclamation-triangle-fill',
  danger: 'exclamation-octagon-fill',
};
</script>

<template>
  <div
    class="app-alert"
    :class="'app-alert-' + props.tone"
    :role="props.tone === 'danger' ? 'alert' : 'status'"
  >
    <i class="bi app-alert-icon" :class="'bi-' + icons[props.tone]" aria-hidden="true"></i>
    <div class="app-alert-body"><slot /></div>
    <button
      v-if="props.dismissible"
      type="button"
      class="app-alert-close"
      aria-label="Close"
      title="Close"
      @click="$emit('close')"
    >
      <i class="bi bi-x-lg" aria-hidden="true"></i>
    </button>
  </div>
</template>

<style scoped>
.app-alert {
  --alert-bg: #eaf2f0;
  --alert-border: #c9dbd6;
  --alert-text: #2b5659;
  --alert-icon: #386d70;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--alert-border);
  border-radius: 8px;
  background: var(--alert-bg);
  color: var(--alert-text);
  font-size: 13px;
  line-height: 1.45;
}
.app-alert-success {
  --alert-bg: #edf5ee;
  --alert-border: #c5dcc7;
  --alert-text: #2f5a31;
  --alert-icon: #418440;
}
.app-alert-warning {
  --alert-bg: #fdf6e6;
  --alert-border: #efdaa9;
  --alert-text: #6f4d0f;
  --alert-icon: #cf7f10;
}
.app-alert-danger {
  --alert-bg: #fbefed;
  --alert-border: #ebc7c2;
  --alert-text: #873a33;
  --alert-icon: #b6413a;
}
.app-alert-icon {
  color: var(--alert-icon);
  font-size: 15px;
  line-height: 1.3;
  flex-shrink: 0;
}
.app-alert-body {
  flex: 1;
  min-width: 0;
}
.app-alert-body :deep(.btn-link) {
  color: inherit;
  font-weight: 600;
  padding: 0 6px;
  vertical-align: baseline;
}
.app-alert-close {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -2px -2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--alert-text);
  opacity: 0.65;
  font-size: 12px;
  cursor: pointer;
}
.app-alert-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--alert-icon) 14%, transparent);
}
</style>
