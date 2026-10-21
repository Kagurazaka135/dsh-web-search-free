import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-web";
import { FreeSearchProvider, type FreeSearchOptions } from "./provider.js";

export type Config = FreeSearchOptions;

export const name = "web-search-free";
export const inject = ["web"];

export function apply(ctx: Context, config: Config = {}): void {
  ctx.web.registerSearchProvider(new FreeSearchProvider(config));
}

export { FreeSearchProvider, FREE_PROVIDER_ID } from "./provider.js";