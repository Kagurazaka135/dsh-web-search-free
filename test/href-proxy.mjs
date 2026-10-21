import assert from "node:assert/strict";
import {
  clearProxyCacheForTests,
  detectProxy,
  unwrapResultHref,
  USER_AGENT,
} from "../lib/backends.js";

const cases = [
  ["https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2F&rut=x", "https://tokio.rs/"],
  ["//duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2F&amp;rut=x", "https://tokio.rs/"],
  ["/l/?uddg=https%3A%2F%2Ftokio.rs%2F&amp;rut=x", "https://tokio.rs/"],
  ["//example.com/a", "https://example.com/a"],
  ["https://plain.example/b", "https://plain.example/b"],
  ["https://duckduckgo.com/about", "https://duckduckgo.com/about"],
];

for (const [input, expected] of cases) {
  assert.equal(unwrapResultHref(input), expected, `unwrapResultHref(${input})`);
}

assert.match(USER_AGENT, /Mozilla\/5\.0 .*Chrome\/\d+/);
assert.ok(!USER_AGENT.includes("compatible; free-search"));

const saved = { ...process.env };
try {
  process.env.FREE_SEARCH_PROXY = "http://127.0.0.1:18080";
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  clearProxyCacheForTests();
  assert.equal(detectProxy(), "http://127.0.0.1:18080", "FREE_SEARCH_PROXY must win");

  process.env.FREE_SEARCH_PROXY = "127.0.0.1:18080";
  clearProxyCacheForTests();
  assert.equal(detectProxy(), "http://127.0.0.1:18080", "bare host:port must gain a scheme");

  delete process.env.FREE_SEARCH_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:18081";
  clearProxyCacheForTests();
  assert.equal(detectProxy(), "http://127.0.0.1:18081", "HTTPS_PROXY must be honored");

  for (const key of Object.keys(process.env)) {
    if (key in saved) continue;
    delete process.env[key];
  }
  Object.assign(process.env, saved);
  clearProxyCacheForTests();
  const registryProxy = detectProxy();
  assert.ok(registryProxy === undefined || /^https?:\/\/[^\s]+$/.test(registryProxy), "registry proxy must be a valid URL or undefined");
} finally {
  for (const key of Object.keys(process.env)) {
    if (key in saved) continue;
    delete process.env[key];
  }
  Object.assign(process.env, saved);
  clearProxyCacheForTests();
}

console.log("href/proxy/UA checks: OK");
