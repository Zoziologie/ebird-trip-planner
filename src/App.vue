<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { liveQuery } from 'dexie';
import { db } from './data/db';
import { refreshTrips } from './state/tripSelection';
const coordinators = new Map();
let syncSubscription, syncApi;
onMounted(() => {
  refreshTrips();
  // Keep offline plan sync running while the trip library is open.
  syncSubscription = liveQuery(() => db.workspaceSync.toArray()).subscribe(async (rows) => {
    const linked = rows.filter((row) => row.cloudId);
    if (linked.length && !syncApi) {
      syncApi = await import('./state/workspaceSync');
      const { initCloud } = await import('./utils/firebaseCloud');
      await initCloud();
    }
    for (const row of linked)
      if (!coordinators.has(row.tripId))
        coordinators.set(row.tripId, syncApi.watchWorkspaceSync(row.tripId));
    for (const [id, controller] of coordinators)
      if (!linked.some((row) => row.tripId === id)) {
        controller.stop();
        coordinators.delete(id);
      }
  });
});
onBeforeUnmount(() => {
  syncSubscription?.unsubscribe();
  coordinators.forEach((controller) => controller.stop());
});
</script>

<template>
  <main class="app-shell"><router-view /></main>
</template>

<style scoped>
.app-shell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f3f5f2;
  font-family: system-ui, sans-serif;
}
</style>
