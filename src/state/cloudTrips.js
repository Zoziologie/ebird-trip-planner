import { ref } from 'vue';

export const cloudConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
export const cloudConfigured = Boolean(
  cloudConfig.apiKey &&
  cloudConfig.authDomain &&
  cloudConfig.projectId &&
  cloudConfig.storageBucket &&
  cloudConfig.appId,
);
export const cloudUser = ref(null);
export const cloudReady = ref(false);
export const cloudLibrary = ref([]);
export const cloudAllowance = ref(1);
export const cloudRequest = ref(null);
export const cloudError = ref('');
export const cloudBindings = ref(JSON.parse(localStorage.getItem('firebaseCloudTrips') || '{}'));
export const cloudLimitBytes = 50 * 1024 * 1024;

export const bindCloudTrip = (tripId, binding) => {
  cloudBindings.value = { ...cloudBindings.value, [tripId]: binding };
  localStorage.setItem('firebaseCloudTrips', JSON.stringify(cloudBindings.value));
};
