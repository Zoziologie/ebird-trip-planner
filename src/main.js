import { createApp } from 'vue';
import 'bootstrap/dist/js/bootstrap.bundle.min.js';
import 'bootswatch/dist/flatly/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './theme.css';
import App from './App.vue';
import router from './router';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

createApp(App).use(router).mount('#app');
