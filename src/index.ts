import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SUPERNOTES_API_URL = "https://api.supernotes.app/v1/cards/simple";
const SUPERNOTES_SELECT_URL = "https://api.supernotes.app/v1/cards/get/select";
const STATIC_TAG = "mcp-note";
const TRIGGER_TAG = "ask-claude";

type CardEntry = {
  data: { id: string; name: string; markup: string; tags: string[]; public_child_count: number };
  membership?: { total_child_count: number };
  parents?: Record<string, unknown>;
};

function formatCard(cardId: string, { data, membership, parents }: CardEntry): string {
  const tagList = data.tags.length ? ` [${data.tags.join(", ")}]` : "";
  const parentIds = parents ? Object.keys(parents) : [];
  const childCount = membership?.total_child_count ?? data.public_child_count;
  const meta = [
    `ID: ${cardId}`,
    parentIds.length ? `Parents: ${parentIds.join(", ")}` : null,
    childCount > 0 ? `Children: ${childCount}` : null,
  ].filter(Boolean).join(" | ");
  return `### ${data.name}${tagList}\n*${meta}*\n${data.markup}`;
}

async function selectCards(body: Record<string, unknown>, apiKey: string): Promise<{ ok: false; error: string } | { ok: true; entries: Record<string, CardEntry> }> {
  let res: Response;
  try {
    res = await fetch(SUPERNOTES_SELECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `Supernotes API error ${res.status}: ${await res.text()}` };
  }
  return { ok: true, entries: (await res.json()) as Record<string, CardEntry> };
}

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

        return {
          content: [{ type: "text", text: "Note created successfully." }],
        };
      }
    );

    this.server.tool(
      "search_notes",
      "Search cards in Supernotes by text query and/or tags. Returns matching cards with their title, tags, and content.",
      {
        query: z.string().optional().describe("Full-text search query"),
        tags: z.array(z.string()).optional().describe("Filter to cards containing all these tags"),
        limit: z.number().int().min(1).max(50).optional().default(10).describe("Maximum number of results to return (default 10, max 50)"),
      },
      async ({ query, tags, limit }) => {
        const body: Record<string, unknown> = {
          limit,
          include_membership_statuses: [-2, -1, 0, 1, 2],
        };
        if (query) body.search = query;
        if (tags?.length) {
          body.filter_group = {
            type: "group",
            op: "and",
            filters: tags.map((tag) => ({ type: "tag", op: "contains", arg: tag })),
          };
        }

        const result = await selectCards(body, this.env.SUPERNOTES_API_KEY);
        if (!result.ok) return { content: [{ type: "text", text: result.error }] };
        if (Object.keys(result.entries).length === 0) return { content: [{ type: "text", text: "No cards found." }] };

        const formatted = Object.entries(result.entries).map(([id, entry]) => formatCard(id, entry)).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }] };
      }
    );

    this.server.tool(
      "get_children",
      "Get the child cards of a given card ID. Use this when search_notes shows a card has children and you need their content.",
      {
        card_id: z.string().describe("ID of the parent card"),
      },
      async ({ card_id }) => {
        const result = await selectCards(
          { parent_id: card_id, include_membership_statuses: [-2, -1, 0, 1, 2] },
          this.env.SUPERNOTES_API_KEY
        );
        if (!result.ok) return { content: [{ type: "text", text: result.error }] };
        if (Object.keys(result.entries).length === 0) return { content: [{ type: "text", text: "No children found." }] };

        const formatted = Object.entries(result.entries).map(([id, entry]) => formatCard(id, entry)).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }] };
      }
    );
  }
}

async function handleWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const cards: any[] = Array.isArray(body) ? body : (body.data ?? []);

  for (const card of cards) {
    const tags: string[] = card.tags ?? [];
    if (!tags.includes(TRIGGER_TAG)) continue;
    ctx.waitUntil(processCard(card, env));
  }

  return new Response("OK", { status: 200 });
}

async function processCard(card: any, env: Env): Promise<void> {
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: `${card.name}\n\n${card.markup}` }],
    }),
  });

  if (!claudeRes.ok) return;

  const claudeJson = (await claudeRes.json()) as any;
  const responseText: string | undefined = claudeJson.content?.[0]?.text;
  if (!responseText) return;

  // Post Claude's reply as a comment
  const commentId = crypto.randomUUID();
  await fetch(`https://api.supernotes.app/v1/comments/${card.id}/${commentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": env.SUPERNOTES_API_KEY,
    },
    body: JSON.stringify({ markup: responseText }),
  });

  // Remove the trigger tag so re-edits don't trigger again
  const remainingTags = (card.tags as string[]).filter((t: string) => t !== TRIGGER_TAG);
  await fetch("https://api.supernotes.app/v1/cards", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": env.SUPERNOTES_API_KEY,
    },
    body: JSON.stringify({ [card.id]: { data: { tags: remainingTags } } }),
  });
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      if (url.searchParams.get("token") !== env.MCP_AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return SupernotesMCP.serve("/mcp").fetch(req, env, ctx);
    }
    if (url.pathname === "/webhook") {
      return handleWebhook(req, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
