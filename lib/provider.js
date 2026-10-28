import { WebError } from "@deepseek-ai/dsh-web";
import { BackendFailure, searchBing, searchDdg, searchExa, searchSerpApi } from "./backends.js";
export const FREE_PROVIDER_ID = "free";
function configuredSerpApiKey(options) {
    const env = globalThis.process?.env;
    return options.serpapiApiKey?.trim() || env?.SERPAPI_API_KEY?.trim() || env?.SERPAPI_KEY?.trim() || undefined;
}
export class FreeSearchProvider {
    id = FREE_PROVIDER_ID;
    serpapiKey;
    constructor(options = {}) {
        this.serpapiKey = configuredSerpApiKey(options);
    }
    available() {
        // Intentionally static: this check must never make a network request.
        return true;
    }
    async search(request, signal) {
        const query = request.query.trim();
        if (!query)
            throw new WebError("Search query must not be empty", "WEB_PROVIDER_FAILED");
        const maxResults = Math.max(1, Math.min(10, Math.trunc(request.maxResults ?? 10)));
        const attempts = [];
        const freeBackends = [
            ["exa-mcp", () => searchExa(query, maxResults, signal)],
            ["bing-html", () => searchBing(query, maxResults, signal)],
            ["ddg-html", () => searchDdg(query, maxResults, signal)],
        ];
        let finalSources;
        let selectedBackend = "";
        for (const [backend, run] of freeBackends) {
            if (signal?.aborted)
                throw new WebError("Search was cancelled", "WEB_SEARCH_ABORTED");
            try {
                const sources = await run();
                if (!sources.length)
                    throw new BackendFailure("empty", `${backend} returned no results`);
                attempts.push({ backend, ok: true });
                finalSources = sources;
                selectedBackend = backend;
                break;
            }
            catch (error) {
                if (signal?.aborted)
                    throw new WebError("Search was cancelled", "WEB_SEARCH_ABORTED");
                attempts.push({ backend, ok: false, reason: error instanceof BackendFailure ? error.reason : "other:unexpected" });
            }
        }
        let lowQuota = false;
        if (!finalSources && this.serpapiKey) {
            if (signal?.aborted)
                throw new WebError("Search was cancelled", "WEB_SEARCH_ABORTED");
            try {
                const result = await searchSerpApi(query, maxResults, this.serpapiKey, signal);
                if (!result.sources.length)
                    throw new BackendFailure("empty", "SerpAPI returned no results");
                attempts.push({ backend: "serpapi", ok: true });
                finalSources = result.sources;
                selectedBackend = "serpapi";
                lowQuota = result.lowQuota;
            }
            catch (error) {
                if (signal?.aborted)
                    throw new WebError("Search was cancelled", "WEB_SEARCH_ABORTED");
                attempts.push({ backend: "serpapi", ok: false, reason: error instanceof BackendFailure ? error.reason : "other:unexpected" });
            }
        }
        if (!finalSources?.length) {
            const summary = attempts.map((item) => `${item.backend}=${item.reason ?? "failed"}`).join(", ");
            throw new WebError(`All configured search backends failed (${summary || "no backend configured"})`, "WEB_PROVIDER_FAILED");
        }
        const wasTruncated = finalSources.length > maxResults;
        const sources = finalSources.slice(0, maxResults);
        const metadata = `backend=${selectedBackend}; paid=${selectedBackend === "serpapi"}; cost_cny=0.000${lowQuota ? "; low_quota=true" : ""}`;
        return { content: metadata, sources, truncated: wasTruncated };
    }
}
