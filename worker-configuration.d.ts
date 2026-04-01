declare namespace Cloudflare {
  interface Env {
    MCP_OBJECT: DurableObjectNamespace<import("./src/index").SupernotesMCP>;
    SUPERNOTES_API_KEY: string;
  }
}

interface Env extends Cloudflare.Env {}
