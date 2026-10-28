import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
export declare const FREE_PROVIDER_ID = "free";
export interface FreeSearchOptions {
    readonly serpapiApiKey?: string;
}
export declare class FreeSearchProvider implements WebSearchProvider {
    readonly id = "free";
    private readonly serpapiKey?;
    constructor(options?: FreeSearchOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
