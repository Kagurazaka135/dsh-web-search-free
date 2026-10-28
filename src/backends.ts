import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import type { WebSearchSource } from "@deepseek-ai/dsh-web";

export type Source = WebSearchSource;

export class BackendFailure extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "BackendFailure";
  }
}

const MAX_RESULTS = 10;
const BACKEND_TIMEOUT_MS = 15_000;

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

type HttpReply = { status: number; headers: Headers; body: string };

function statusFailure(status: number): BackendFailure {
  return new BackendFailure(status >= 500 ? "http_5xx" : "http_4xx", `HTTP ${status}`);
}

type RuntimeEnv = { process?: { env?: Record<string, string | undefined>; platform?: string } };

function runtimeProcess(): NonNullable<RuntimeEnv["process"]> | undefined {
  return (globalThis as RuntimeEnv).process;
}

const PROXY_CACHE_MS = 60_000;
let proxyCache: { checkedAt: number; value: string | undefined } | undefined;

export function clearProxyCacheForTests(): void {
  proxyCache = undefined;
}

function normalizeProxy(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return undefined;
    const auth = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
      : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return undefined;
  }
}

function readRegistryValue(name: string): string | undefined {
  try {
    const output = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", name],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    return new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(output)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function resolveProxy(): string | undefined {
  const env = runtimeProcess()?.env;
  const explicit = env?.FREE_SEARCH_PROXY?.trim() || env?.HTTPS_PROXY?.trim() || env?.HTTP_PROXY?.trim();
  if (explicit) return normalizeProxy(explicit);
  if (runtimeProcess()?.platform !== "win32") return undefined;

  const enabled = readRegistryValue("ProxyEnable");
  if (!enabled || Number.parseInt(enabled.replace(/^0x/i, ""), 16) !== 1) return undefined;
  const server = readRegistryValue("ProxyServer");
  if (!server) return undefined;
  const https = /(?:^|;)\s*https=([^;]+)/i.exec(server)?.[1];
  const http = /(?:^|;)\s*http=([^;]+)/i.exec(server)?.[1];
  return normalizeProxy((https ?? http ?? server.split(";")[0] ?? "").trim());
}

/** Environment variables first, then the Windows registry, matching core/search_core.py. */
export function detectProxy(): string | undefined {
  const now = Date.now();
  if (proxyCache && now - proxyCache.checkedAt < PROXY_CACHE_MS) return proxyCache.value;
  const value = resolveProxy();
  proxyCache = { checkedAt: now, value };
  return value;
}

function requestHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key.toLowerCase()] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) record[key.toLowerCase()] = value;
  }
  return record;
}

function headersFromRaw(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return headers;
}

function openTunnel(proxy: URL, host: string, port: string, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: {
        host: `${host}:${port}`,
        ...(proxy.username
          ? {
              "proxy-authorization":
                "Basic " + btoa(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`),
            }
          : {}),
      },
      timeout: Math.max(1, timeoutMs),
    });
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("proxy request was cancelled"));
    if (signal?.aborted) {
      fail(new Error("proxy request was cancelled"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("connect", (response, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (response.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with HTTP ${response.statusCode ?? 0}`));
      }
    });
    request.on("timeout", () => fail(new Error("proxy CONNECT timed out")));
    request.on("error", (error) => fail(error));
    request.end();
  });
}

function openTls(socket: Socket, hostname: string, signal?: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername: hostname });
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      tlsSocket.destroy();
      reject(new Error("proxy request was cancelled"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tlsSocket);
    });
    tlsSocket.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function requestThroughTunnel(
  target: URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpReply> {
  const proxyValue = detectProxy();
  if (!proxyValue) throw new Error("no proxy is configured");
  if (target.protocol !== "https:") throw new Error(`proxy transport does not support ${target.protocol}`);

  const proxy = new URL(proxyValue);
  const port = target.port || "443";
  const tunnel = await openTunnel(proxy, target.hostname, port, timeoutMs, signal);
  const tlsSocket = await openTls(tunnel, target.hostname, signal);

  const headers = requestHeaderRecord(init.headers);
  headers["user-agent"] ??= USER_AGENT;
  headers["accept-encoding"] = "identity";
  headers["connection"] = "close";
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new Error("proxy transport only supports string request bodies");
  }
  const body = typeof init.body === "string" ? init.body : undefined;
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      finish(new Error("proxy request was cancelled"));
      request.destroy();
    };
    const request = httpsRequest(
      {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        createConnection: () => tlsSocket,
        timeout: Math.max(1, timeoutMs),
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: headersFromRaw(response.rawHeaders),
            body: new TextDecoder("utf-8").decode(bytes),
          });
        });
        response.on("error", (error) => finish(error));
      },
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => {
      finish(new Error("proxy request timed out"));
      request.destroy();
    });
    request.on("error", (error) => finish(error));
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function proxyFetchText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpReply> {
  let current = new URL(url);
  let nextInit = init;
  for (let hop = 0; hop < 5; hop += 1) {
    const reply = await requestThroughTunnel(current, nextInit, timeoutMs, signal);
    const location = reply.headers.get("location");
    if (reply.status >= 300 && reply.status < 400 && location) {
      const method = (nextInit.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") throw new Error(`proxy transport refuses to redirect ${method}`);
      current = new URL(location, current);
      nextInit = { ...nextInit, method: "GET", body: undefined };
      continue;
    }
    return reply;
  }
  throw new Error("too many proxy redirects");
}

async function directFetchText(url: string, init: RequestInit, signal: AbortSignal): Promise<HttpReply> {
  const response = await fetch(url, { ...init, signal });
  const body = await response.text();
  if (!response.ok) throw statusFailure(response.status);
  return { status: response.status, headers: response.headers, body };
}

async function fetchText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpReply> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw new BackendFailure("network", "Search was cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  try {
    const reply = detectProxy() && url.startsWith("https://")
      ? await proxyFetchText(url, init, timeoutMs, controller.signal)
      : await directFetchText(url, init, controller.signal);
    if (reply.status < 200 || reply.status >= 300) throw statusFailure(reply.status);
    return reply;
  } catch (error) {
    if (error instanceof BackendFailure) throw error;
    if (signal?.aborted) throw new BackendFailure("network", "Search was cancelled");
    if (timedOut) throw new BackendFailure("timeout", "request timed out");
    throw new BackendFailure("network", "request failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseSse(body: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (!data.length) continue;
    const raw = data.join("\n").trim();
    if (raw === "[DONE]") continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) messages.push(value as Record<string, unknown>);
    } catch {
      throw new BackendFailure("parse_error", "invalid SSE JSON");
    }
  }
  if (!messages.length) throw new BackendFailure("parse_error", "SSE response contained no JSON message");
  return messages;
}

function sourceFromObject(value: unknown): Source | undefined {
  if (!isRecord(value)) return undefined;
  const url = typeof value.url === "string" ? value.url : typeof value.link === "string" ? value.link : "";
  if (!/^https?:\/\//i.test(url)) return undefined;
  const title = typeof value.title === "string" ? value.title : undefined;
  const snippet = typeof value.snippet === "string" ? value.snippet : typeof value.summary === "string" ? value.summary : undefined;
  const publishedAt = typeof value.publishedAt === "string" ? value.publishedAt : typeof value.date === "string" ? value.date : undefined;
  return { url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(publishedAt ? { publishedAt } : {}) };
}

function objectSources(value: unknown): Source[] {
  if (Array.isArray(value)) return value.map(sourceFromObject).filter((item): item is Source => Boolean(item));
  if (!isRecord(value)) return [];
  for (const key of ["results", "sources", "organic_results"]) {
    if (Array.isArray(value[key])) return (value[key] as unknown[]).map(sourceFromObject).filter((item): item is Source => Boolean(item));
  }
  for (const key of ["structuredContent", "result", "data"]) {
    const nested = objectSources(value[key]);
    if (nested.length) return nested;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseExaText(text: string): Source[] {
  const out: Source[] = [];
  const pattern = /^Title:\s*(.*?)\s*\r?\nURL:\s*(https?:\/\/\S+)([\s\S]*?)(?=^Title:\s*|$)/gm;
  for (const match of text.matchAll(pattern)) {
    const title = match[1]?.trim() ?? "";
    const url = match[2]?.trim() ?? "";
    const remainder = match[3] ?? "";
    const highlights = /^Highlights:\s*\r?\n([\s\S]*)/m.exec(remainder)?.[1]?.trim() ?? "";
    out.push({ title, url, ...(highlights ? { snippet: highlights } : {}) });
  }
  return out;
}

export async function searchExa(query: string, maxResults: number, signal?: AbortSignal): Promise<Source[]> {
  const url = "https://mcp.exa.ai/mcp";
  const deadline = Date.now() + BACKEND_TIMEOUT_MS;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dsh-web-search-free-kg", version: "0.1.0" } },
  };
  const initialized = await fetchText(url, { method: "POST", headers, body: JSON.stringify(init) }, deadline - Date.now(), signal);
  const sessionId = initialized.headers.get("Mcp-Session-Id");
  if (!sessionId) throw new BackendFailure("parse_error", "Exa initialize response omitted the session id");
  const call = {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, numResults: Math.min(MAX_RESULTS, maxResults) } },
  };
  const reply = await fetchText(url, {
    method: "POST", headers: { ...headers, "mcp-session-id": sessionId }, body: JSON.stringify(call),
  }, deadline - Date.now(), signal);
  const found: Source[] = [];
  for (const message of parseSse(reply.body)) {
    const result = message.result;
    if (isRecord(result) && result.isError) throw new BackendFailure("other:Exa tool error", "Exa search returned a tool error");
    found.push(...objectSources(message));
    if (isRecord(result) && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isRecord(block) && typeof block.text === "string") found.push(...parseExaText(block.text));
      }
    }
  }
  if (!found.length) throw new BackendFailure("empty", "Exa returned no parseable results");
  return found.slice(0, MAX_RESULTS);
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, token: string) => {
    if (token[0] === "#") {
      const hex = token[1]?.toLowerCase() === "x";
      const number = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
    }
    return named[token.toLowerCase()] ?? whole;
  });
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function looksLikeCaptcha(html: string): boolean {
  const clean = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const attributes = [...clean.matchAll(/\b(?:id|class|name)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase()).join(" ");
  if (/\b(captcha|challenge-platform|cf-challenge)\b/.test(attributes)) return true;
  const text = visibleText(clean).toLowerCase();
  return /\bcaptcha\b|verify (?:that )?you are (?:a )?human|verify you(?:'re| are) not a robot|unusual traffic|complete (?:the|this|following) challenge|select all squares|confirm this search was made by a human/.test(text);
}

function classBlocks(source: string, tag: "li" | "div", classToken: string): string[] {
  const tokenPattern = new RegExp(`(?:^|\\s)${classToken}(?:\\s|$)`);
  const tagPattern = /<\/?([a-z][\w:-]*)\b([^>]*)>/gi;
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  for (const match of source.matchAll(tagPattern)) {
    const name = match[1]!.toLowerCase();
    const raw = match[0];
    const closing = raw.startsWith("</");
    if (start < 0) {
      if (!closing && name === tag) {
        const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(match[2] ?? "")?.[1] ?? "";
        if (tokenPattern.test(cls)) {
          start = match.index!;
          depth = 1;
        }
      }
      continue;
    }
    if (name !== tag) continue;
    if (closing) {
      depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(start, match.index! + raw.length));
        start = -1;
      }
    } else if (!raw.endsWith("/>")) depth += 1;
  }
  return blocks;
}

/**
 * Resolve engine-wrapped result links to their destination URL.
 *
 * DuckDuckGo wraps results as `//duckduckgo.com/l/?uddg=<urlencoded>`, and
 * protocol-relative hrefs carry no scheme. Both forms fail a plain
 * `^https?://` check, which silently dropped every DDG result.
 */
export function unwrapResultHref(raw: string): string {
  let href = decodeEntities(raw.trim());
  if (href.startsWith("//")) href = "https:" + href;
  // DDG also serves the wrapper root-relative (`/l/?uddg=...`) depending on the
  // session, so resolve that form against the DDG origin before parsing.
  if (href.startsWith("/l/?")) href = "https://duckduckgo.com" + href;
  try {
    const parsed = new URL(href);
    const isDdg = parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com");
    if (isDdg && parsed.pathname.startsWith("/l/")) {
      const target = parsed.searchParams.get("uddg");
      if (target) return target;
    }
  } catch {
    // Not a valid URL; keep the original so the caller can reject it.
  }
  return href;
}

function parseCards(source: string, backend: "bing-html" | "ddg-html"): Source[] {
  const blocks = backend === "bing-html" ? classBlocks(source, "li", "b_algo") : classBlocks(source, "div", "result");
  const output: Source[] = [];
  for (const block of blocks) {
    const anchors = [...block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
    const usable = anchors.find((match) => {
      const raw = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? "")?.[1] ?? "";
      return /^https?:\/\//i.test(unwrapResultHref(raw));
    });
    if (!usable) continue;
    const href = unwrapResultHref(/\bhref\s*=\s*["']([^"']+)["']/i.exec(usable[1] ?? "")?.[1] ?? "");
    const title = visibleText(usable[2] ?? "");
    const snippetMatch = /<(a|p|div)\b[^>]*class\s*=\s*["'][^"']*(?:b_caption|b_algoSlug|result__snippet)[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/i.exec(block);
    const snippet = snippetMatch ? visibleText(snippetMatch[2] ?? "") : "";
    output.push({ url: href, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return output;
}

async function htmlSearch(query: string, backend: "bing-html" | "ddg-html", signal?: AbortSignal): Promise<Source[]> {
  const endpoint = backend === "bing-html" ? "https://cn.bing.com/search" : "https://html.duckduckgo.com/html/";
  const url = `${endpoint}?${new URLSearchParams({ q: query }).toString()}`;
  const reply = await fetchText(url, { headers: { "user-agent": USER_AGENT } }, BACKEND_TIMEOUT_MS, signal);
  if (looksLikeCaptcha(reply.body)) throw new BackendFailure("captcha", `${backend} returned a challenge page`);
  const sources = parseCards(reply.body, backend);
  if (!sources.length) throw new BackendFailure("empty", `${backend} returned no parseable results`);
  return sources.slice(0, MAX_RESULTS);
}

export const searchBing = (query: string, _maxResults: number, signal?: AbortSignal) => htmlSearch(query, "bing-html", signal);
export const searchDdg = (query: string, _maxResults: number, signal?: AbortSignal) => htmlSearch(query, "ddg-html", signal);

let quotaCache: { key: string; checkedAt: number; remaining: number } | undefined;

export async function serpApiQuota(key: string, signal?: AbortSignal, timeoutMs = BACKEND_TIMEOUT_MS): Promise<number> {
  const now = Date.now();
  if (quotaCache?.key === key && now - quotaCache.checkedAt < 600_000) return quotaCache.remaining;
  const url = `https://serpapi.com/account?${new URLSearchParams({ api_key: key }).toString()}`;
  const reply = await fetchText(url, { headers: { accept: "application/json" } }, timeoutMs, signal);
  let body: unknown;
  try { body = JSON.parse(reply.body); } catch { throw new BackendFailure("parse_error", "Could not read SerpAPI quota response"); }
  const remaining = isRecord(body) ? Number(body.total_searches_left) : Number.NaN;
  if (!Number.isInteger(remaining)) throw new BackendFailure("parse_error", "Could not read SerpAPI quota response");
  quotaCache = { key, checkedAt: now, remaining };
  return remaining;
}

export async function searchSerpApi(query: string, maxResults: number, key: string, signal?: AbortSignal): Promise<{ sources: Source[]; lowQuota: boolean }> {
  const deadline = Date.now() + BACKEND_TIMEOUT_MS;
  const remaining = await serpApiQuota(key, signal, deadline - Date.now());
  if (remaining <= 0) throw new BackendFailure("quota_exhausted", "SerpAPI quota is exhausted");
  const url = `https://serpapi.com/search?${new URLSearchParams({ engine: "google", q: query, api_key: key, num: String(Math.min(MAX_RESULTS, maxResults)) }).toString()}`;
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new BackendFailure("timeout", "SerpAPI quota check exhausted the backend time limit");
  const reply = await fetchText(url, { headers: { accept: "application/json" } }, timeoutMs, signal);  let body: unknown;
  try { body = JSON.parse(reply.body); } catch { throw new BackendFailure("parse_error", "SerpAPI returned invalid JSON"); }
  if (!isRecord(body)) throw new BackendFailure("parse_error", "SerpAPI returned invalid JSON");
  if (body.error) throw new BackendFailure("other:SerpAPI search error", "SerpAPI returned an error response");
  const sources = objectSources(body);
  if (!sources.length) throw new BackendFailure("empty", "SerpAPI returned no organic results");
  return { sources: sources.slice(0, MAX_RESULTS), lowQuota: remaining <= 10 };
}

export function clearQuotaCacheForTests(): void {
  quotaCache = undefined;
}