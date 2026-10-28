import type { WebSearchSource } from "@deepseek-ai/dsh-web";
export type Source = WebSearchSource;
export declare class BackendFailure extends Error {
    readonly reason: string;
    constructor(reason: string, message: string);
}
export declare const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
export declare function clearProxyCacheForTests(): void;
/** Environment variables first, then the Windows registry, matching core/search_core.py. */
export declare function detectProxy(): string | undefined;
export declare function searchExa(query: string, maxResults: number, signal?: AbortSignal): Promise<Source[]>;
export declare function looksLikeCaptcha(html: string): boolean;
/**
 * Resolve engine-wrapped result links to their destination URL.
 *
 * DuckDuckGo wraps results as `//duckduckgo.com/l/?uddg=<urlencoded>`, and
 * protocol-relative hrefs carry no scheme. Both forms fail a plain
 * `^https?://` check, which silently dropped every DDG result.
 */
export declare function unwrapResultHref(raw: string): string;
export declare const searchBing: (query: string, _maxResults: number, signal?: AbortSignal) => Promise<WebSearchSource[]>;
export declare const searchDdg: (query: string, _maxResults: number, signal?: AbortSignal) => Promise<WebSearchSource[]>;
export declare function serpApiQuota(key: string, signal?: AbortSignal, timeoutMs?: number): Promise<number>;
export declare function searchSerpApi(query: string, maxResults: number, key: string, signal?: AbortSignal): Promise<{
    sources: Source[];
    lowQuota: boolean;
}>;
export declare function clearQuotaCacheForTests(): void;
