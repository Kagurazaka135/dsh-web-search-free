import { FreeSearchProvider } from "../lib/index.js";
import { searchDdg } from "../lib/backends.js";

const query = process.argv.slice(2).join(" ") || "rust tokio select macro";
const provider = new FreeSearchProvider();
let failed = false;

try {
  const result = await provider.search({ query, maxResults: 5 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const value = error && typeof error === "object" ? error : new Error(String(error));
  console.error(JSON.stringify({ code: value.code ?? "WEB_PROVIDER_FAILED", message: value.message }));
  failed = true;
}

// DDG is the backend that regressed twice (bot UA, wrapped hrefs), so it is
// exercised directly: the provider chain stops at Exa and would hide it.
try {
  const sources = await searchDdg(query, 3);
  const usable = sources.filter((source) => /^https?:\/\//i.test(source.url) && !source.url.includes("duckduckgo.com/l/"));
  if (!usable.length) throw new Error("DDG returned no unwrapped result URLs");
  console.error(JSON.stringify({ backend: "ddg-html", results: usable.length, first: usable[0] }));
} catch (error) {
  const value = error && typeof error === "object" ? error : new Error(String(error));
  console.error(JSON.stringify({ backend: "ddg-html", code: value.reason ?? "FAILED", message: value.message }));
  failed = true;
}

process.exitCode = failed ? 1 : 0;
