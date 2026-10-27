// Hospitable Pages: the Worker.
// It serves the host's site, takes new versions of it from the builder (with
// the publish key only), and hands out public listing data. It only reads
// from Hospitable and refreshes that data once an hour.

import { handleData } from './api.js';
import { Listings, isDummy } from './listings.js';
import { handlePages } from './pages.js';
import { handlePublish } from './publish.js';

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/api/site' || path.startsWith('/api/site/')) return await handlePublish(request, url, path, env);
      if (path === '/api' || path.startsWith('/api/')) return await handleData(request, url, path, env);
      return await handlePages(request, url, path, env);
    } catch (err) {
      console.error('[hospitable-pages] unexpected error', err);
      return new Response('Something went wrong. Please try again in a moment.\n', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },

  /**
   * Hourly refresh of every data set a page has asked for.
   * @param {ScheduledController} controller
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    if (isDummy(env)) return;
    const report = await new Listings(env).refresh();
    console.log('[hospitable-pages] refresh', JSON.stringify(report));
  },
};
