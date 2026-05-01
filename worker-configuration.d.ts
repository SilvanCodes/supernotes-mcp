declare namespace Cloudflare {
  interface Env {
    MCP_OBJECT: DurableObjectNamespace<import("./src/index").SupernotesMCP>;
    SUPERNOTES_API_KEY: string;
    MCP_AUTH_TOKEN: string;
  }
}

interface Env extends Cloudflare.Env {}
