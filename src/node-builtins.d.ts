// Minimal ambient declarations for the Node built-ins used by the proxy
// transport. The plugin deliberately ships no Node typings dependency, so only
// the handful of members this package touches are declared here.
//
// This file exists only because the package has no @types/node. If that
// dependency is ever added, delete this file: the duplicate module
// declarations would conflict with the real ones.

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout?: number; windowsHide?: boolean },
  ): string;
}

declare module "node:net" {
  export interface Socket {
    destroy(error?: Error): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }
}

declare module "node:tls" {
  import type { Socket } from "node:net";

  export interface TLSSocket extends Socket {
    readonly encrypted: boolean;
  }

  export function connect(
    options: { socket: Socket; servername?: string },
    callback?: () => void,
  ): TLSSocket;
}

declare module "node:http" {
  import type { Socket } from "node:net";

  export interface IncomingMessage {
    readonly statusCode?: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly rawHeaders: string[];
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    destroy(error?: Error): void;
  }

  export interface ClientRequest {
    on(event: "connect", listener: (response: IncomingMessage, socket: Socket, head: Uint8Array) => void): this;
    on(event: "timeout", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    end(data?: string): void;
    destroy(error?: Error): void;
  }

  export interface RequestOptions {
    hostname?: string;
    host?: string;
    port?: number | string;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    timeout?: number;
    createConnection?: () => Socket;
    agent?: unknown;
  }

  export function request(
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ): ClientRequest;
}

declare module "node:https" {
  import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

  export function request(
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ): ClientRequest;
}
