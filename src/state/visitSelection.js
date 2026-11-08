import { ref, watch } from 'vue';

const selectedVisitId = ref(localStorage.getItem('selectedVisitId') || '');

watch(selectedVisitId, (value) => {
  const normalized = value === null || value === undefined || value === '' ? '' : String(value);
  if (normalized !== value) {
    selectedVisitId.value = normalized;
    return;
  }
  if (normalized) {
    localStorage.setItem('selectedVisitId', normalized);
  } else {
    localStorage.removeItem('selectedVisitId');
  }
});

export { selectedVisitId };
