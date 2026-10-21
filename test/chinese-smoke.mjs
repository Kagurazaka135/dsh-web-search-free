import assert from "node:assert/strict";
import { searchDdg, searchExa } from "../lib/backends.js";

const query = "北京 供暖时间";
const bad = /[\uFFFD\u00EF\u00BF\u00BD]|ï¿½/;

for (const [name, run] of [["exa", searchExa], ["ddg", searchDdg]]) {
  const sources = await run(query, 3);
  assert.ok(sources.length > 0, `${name} returned no results`);
  const titles = sources.map((source) => source.title ?? "").filter(Boolean);
  assert.ok(titles.length > 0, `${name} returned no titles`);
  assert.ok(titles.some((title) => /[\u4e00-\u9fff]/.test(title)), `${name} titles contain no CJK characters`);
  for (const title of titles) {
    assert.ok(!bad.test(title), `${name} title contains mojibake: ${title}`);
    assert.ok(!/Ã|Â/.test(title), `${name} title looks like Latin-1 mojibake: ${title}`);
  }
  console.log(JSON.stringify({ backend: name, results: sources.length, titles: titles.slice(0, 3) }));
}

console.log("chinese encoding: OK");
