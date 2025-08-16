declare module "eventsource" {
  import { IncomingHttpHeaders } from "http";
  class EventSource {
    constructor(url: string, init?: { headers?: IncomingHttpHeaders });
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    close(): void;
  }
  export = EventSource;
}

declare module "@modelcontextprotocol/sdk/server/mcp.js";
declare module "@modelcontextprotocol/sdk/server/stdio.js";
declare module "@modelcontextprotocol/sdk/server/streamableHttp.js";





