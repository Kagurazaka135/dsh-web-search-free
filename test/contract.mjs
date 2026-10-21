import assert from "node:assert/strict";
import { FreeSearchProvider } from "../lib/index.js";
import { clearProxyCacheForTests } from "../lib/backends.js";
import { WebError } from "@deepseek-ai/dsh-web";

const originalFetch = globalThis.fetch;
const saved = { ...process.env };
let failed = false;

try {
  // available() must stay a pure static check: no network, no proxy probing.
  globalThis.fetch = () => {
    throw new Error("available() must not call fetch");
  };
  const provider = new FreeSearchProvider();
  assert.equal(provider.available(), true);

  // Empty query is a caller error, not an empty result set.
  await assert.rejects(
    () => provider.search({ query: "   ", maxResults: 3 }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_FAILED",
  );

  // Every backend unreachable must surface WebError, never an empty array.
  delete process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_KEY;
  process.env.FREE_SEARCH_PROXY = "http://127.0.0.1:1";
  clearProxyCacheForTests();
  const offline = new FreeSearchProvider();
  globalThis.fetch = () => Promise.reject(new TypeError("offline"));
  await assert.rejects(
    () => offline.search({ query: "rust tokio", maxResults: 3 }),
    (error) => error instanceof WebError && error.code === "WEB_PROVIDER_FAILED",
  );

  console.log("provider contract: OK");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (key in saved) continue;
    delete process.env[key];
  }
  Object.assign(process.env, saved);
}

process.exitCode = failed ? 1 : 0;
