/**
 * Package-root entry, for a profile that mounts the plugin by relative path:
 *
 *     - insert:
 *         - id: price-peak
 *           name: './plugins/dsh-price-peak/index.js'
 *
 * The implementation lives in `lib/` so that the server-side files a reader is
 * most likely to want (`core.js`, `parse.js`) sit beside the artifact the client
 * loads (`lib/client.js`), matching the layout of the shipped dsh packages. This
 * file exists only so the mounted path stays short and obvious.
 */
export { Config, FORCED_REFRESH_FLOOR_MS, STATE_PATH, apply, fetchPricing, inject, name } from "./lib/index.js";
