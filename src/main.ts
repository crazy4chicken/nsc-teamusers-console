import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'
import { authStore } from './stores/authStore'

/**
 * Starts the app. With `VITE_MOCK=1` in a dev build the in-memory mock backend
 * is installed before anything issues a request.
 *
 * The import is dynamic on purpose and MUST stay that way: a static import
 * would put the mock (and every fixture in `src/api/mock/`) into the production
 * bundle graph, because `import.meta.env.DEV` removes the branch but cannot
 * remove a statically linked module. With the dynamic form, production builds
 * drop the branch and the chunk is never emitted.
 */
async function start(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const { installMockBackend } = await import('./api/mock')
    installMockBackend()
  }

  // Resuming the session is started before the first navigation; the router guard
  // awaits the same single-flight promise, so the refresh token is rotated once.
  void authStore.bootstrap()

  createApp(App).use(router).mount('#app')
}

void start()
