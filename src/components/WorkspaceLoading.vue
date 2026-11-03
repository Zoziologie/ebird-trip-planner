<script setup>
import { onMounted, ref } from 'vue';

defineProps({ message: { type: String, default: 'Preparing your trip…' } });
const dialog = ref(null);
onMounted(() => dialog.value.showModal());
</script>

<template>
  <dialog
    ref="dialog"
    class="workspace-loading"
    aria-labelledby="loading-title"
    aria-describedby="loading-message"
    @cancel.prevent
  >
    <span class="workspace-loading-icon" aria-hidden="true"><i class="bi bi-feather"></i></span>
    <h1 id="loading-title">Opening workspace</h1>
    <p id="loading-message" role="status">{{ message }}</p>
    <progress aria-label="Opening workspace"></progress>
  </dialog>
</template>

<style scoped>
.workspace-loading::backdrop {
  background: rgb(30 46 44 / 40%);
}
.workspace-loading {
  width: min(calc(100% - 48px), 390px);
  padding: 30px;
  border: 1px solid #dce3df;
  border-radius: 10px;
  background: #fcfcfa;
  color: #2b3435;
  box-shadow: 0 16px 48px rgb(30 46 44 / 20%);
  text-align: center;
  font:
    14px/1.5 system-ui,
    sans-serif;
}
.workspace-loading-icon {
  display: inline-grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: #eaf2f0;
  color: #386d70;
  font-size: 23px;
}
.workspace-loading h1 {
  margin: 16px 0 6px;
  font-size: 20px;
  font-weight: 600;
}
.workspace-loading p {
  margin: 0 0 18px;
  color: #687573;
}
.workspace-loading progress {
  width: 100%;
  height: 6px;
  accent-color: #386d70;
}
</style>
