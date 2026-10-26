import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// https://vite.dev/config/
export default defineConfig({
  base: "/ebird-trip-planner/",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg,webmanifest,woff,woff2,jpg,jpeg,gif,webp,avif,json}",
        ],
        // bootstrap-icons.css appends a bare hex cache-busting param to its font
        // URLs (e.g. `?e34853135f9e39acf64315236852cd5a`). Workbox precaches the
        // font without it, so the actual request never matches the cache entry
        // and the icon font silently fails to load offline. Strip it like the
        // default utm_/fbclid params.
        ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^[0-9a-f]{16,}$/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/directions\/v5\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "mapbox-directions",
              networkTimeoutSeconds: 5,
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
            },
          },
          {
            urlPattern: /^https:\/\/(?:api\.mapbox\.com|.*\.tiles\.mapbox\.com)\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mapbox-resources",
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 14,
              },
            },
          },
        ],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10 MB
      },
      manifest: {
        name: "eBird Trip Planner",
        short_name: "eBird Trip",
        description: "Offline-friendly birding trip planning and species reports.",
        theme_color: "#2a9d8f",
        background_color: "#ffffff",
        display: "standalone",
        scope: "/ebird-trip-planner/",
        start_url: "/ebird-trip-planner/",
        icons: [
          {
            src: "/ebird-trip-planner/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/ebird-trip-planner/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
});
