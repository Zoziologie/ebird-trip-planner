import { ref, watch } from 'vue';
import { db } from '../data/db';

const trips = ref([]);
const selectedTripId = ref(localStorage.getItem('selectedTripId') || '');

const refreshTrips = async () => {
  trips.value = await db.trips.orderBy('updatedAt').reverse().toArray();
  if (trips.value.length === 0) {
    selectedTripId.value = '';
  } else if (!trips.value.some((trip) => trip.id === selectedTripId.value)) {
    selectedTripId.value = trips.value[0].id;
  }
};

watch(selectedTripId, (value) => {
  if (value) {
    localStorage.setItem('selectedTripId', value);
  } else {
    localStorage.removeItem('selectedTripId');
  }
});

export { trips, selectedTripId, refreshTrips };
