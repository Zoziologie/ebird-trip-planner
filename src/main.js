import { createApp } from 'vue';
import 'bootstrap/dist/js/bootstrap.bundle.min.js';
import 'bootswatch/dist/flatly/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './theme.css';
import App from './App.vue';
import router from './router';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

// A tab left open across a deploy still runs the old bundle, whose lazily loaded pages no
// longer exist on the server. Reload once to pick up the new build instead of showing a blank
// page; the timestamp guard stops a reload loop if the file is missing for another reason.
const reloadForNewBuild = () => {
  const key = 'staleBuildReloadAt';
  try {
    if (Date.now() - Number(sessionStorage.getItem(key) || 0) < 10000) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Storage unavailable: still reload once for this page load.
  }
  window.location.reload();
  return true;
};
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});
router.onError((error) => {
  if (/dynamically imported module|Importing a module script failed/i.test(error?.message)) {
    reloadForNewBuild();
  }
});

createApp(App).use(router).mount('#app');
