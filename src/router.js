import { createRouter, createWebHistory } from 'vue-router';

const editor = (to) => ({ path: '/workspace', query: to.query });
const routes = [
  {
    path: '/',
    redirect: (to) => ({ path: to.query.cloud ? '/workspace' : '/trips', query: to.query }),
  },
  { path: '/trips', component: () => import('./pages/Trips.vue'), meta: { fullPage: true } },
  {
    path: '/workspace',
    component: () => import('./pages/TripWorkspace.vue'),
    meta: { fullPage: true },
  },
  {
    path: '/create',
    redirect: (to) => ({ path: to.query.cloud ? '/workspace' : '/trips', query: to.query }),
  },
  { path: '/buildTrip', redirect: editor },
  {
    path: '/speciesList',
    redirect: (to) => ({ path: '/workspace', query: { ...to.query, view: 'species' } }),
  },
  { path: '/speciesMap', redirect: editor },
];
export default createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes });
