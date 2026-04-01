import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SUPERNOTES_API_URL = "https://api.supernotes.app/v1/cards/simple";
const STATIC_TAG = "mcp-note";

export class SupernotesMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Supernotes MCP", version: "0.1.0" });

  async init() {
    this.server.tool(
      "create_note",
      `Creates a new note card in Supernotes.
Pass source_url with the current conversation URL (e.g. https://claude.ai/chat/...) to embed a backlink in the note footer.
Always returns a direct link to the created card.`,
      {
        name: z.string().describe("Title of the note"),
        content: z.string().describe("Body of the note in Markdown"),
        source_url: z
          .string()
          .url()
          .optional()
          .describe(
            "URL of the source conversation or page to embed as a backlink (e.g. the current Claude.ai conversation URL)"
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Additional tags to apply to the card (mcp-note is always added automatically)"),
      },
      async ({ name, content, source_url, tags }) => {
        const allTags = [STATIC_TAG, ...(tags ?? [])];

        let markup = content;
        if (source_url) {
          markup += `\n\n---\n*Source: [${source_url}](${source_url})*`;
        }

        let res: Response;
        try {
          res = await fetch(SUPERNOTES_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Api-Key": this.env.SUPERNOTES_API_KEY,
            },
            body: JSON.stringify({ name, markup, tags: allTags }),
          });
        } catch (err) {
          return {
            content: [{ type: "text", text: `Network error: ${String(err)}` }],
          };
        }

        if (!res.ok) {
          const body = await res.text();
          return {
            content: [{ type: "text", text: `Supernotes API error ${res.status}: ${body}` }],
          };
        }

        const json = (await res.json()) as { data: { id: string } };
        const cardUrl = `https://my.supernotes.app/?preview=${json.data.id}`;

        return {
          content: [{ type: "text", text: `Note created: ${cardUrl}` }],
        };
      }
    );
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      return SupernotesMCP.serve("/mcp").fetch(req, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
