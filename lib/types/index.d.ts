import type { Context } from "@deepseek-ai/cordis";
import { type FreeSearchOptions } from "./provider.js";
export type Config = FreeSearchOptions;
export declare const name = "web-search-free";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): void;
export { FreeSearchProvider, FREE_PROVIDER_ID } from "./provider.js";
