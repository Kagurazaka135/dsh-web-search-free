import { FreeSearchProvider } from "./provider.js";
export const name = "web-search-free";
export const inject = ["web"];
export function apply(ctx, config = {}) {
    ctx.web.registerSearchProvider(new FreeSearchProvider(config));
}
export { FreeSearchProvider, FREE_PROVIDER_ID } from "./provider.js";
