// Web tools: the platform's web_search and web_fetch offered to the model
// as the agent's own tools (`webTools`). The platform runs them and bills
// them per call; the descriptions come from it (`GET /v1/tools`, cached by
// the SDK), so a better description or a new limit needs no new package.
// They run like any other tool — in the loop, beside the app's tools,
// shown in the chat as cards — and their cost is added to the agent's usage.

import type { PlatformTools } from "./provider.js";
import type { JSONSchema, Tool } from "./types.js";

/** The platform tools `webTools` offers. */
export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;

const svg = (body: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
/** lucide "globe". */
export const GLOBE_ICON = svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>');
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>');

const GUIDELINES = [
  "web_search finds pages and web_fetch reads one: use them for facts you can't know or that change (news, prices, releases, people, places, a work's details, a reference the user names), not for what the conversation or your own knowledge already answers.",
  "Read the most relevant results with web_fetch before relying on them; a snippet is not the page. Say where an answer came from, with the link.",
  "Each call costs the user a little: search with a precise query, and stop when you have enough.",
];

function hostOf(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const path = u.pathname === "/" ? "" : u.pathname;
    return u.host + (path.length > 32 ? path.slice(0, 31) + "…" : path);
  } catch {
    return url.slice(0, 48);
  }
}

/**
 * The tools as the agent holds them. `onCost` gets what each call charged
 * (USD, the creator's fee included); a call that fails throws, and costs
 * nothing.
 */
export async function webTools(
  platform: PlatformTools,
  opts: { signal?: AbortSignal; onCost?: (usd: number) => void } = {},
): Promise<Tool[]> {
  const list = await platform.list(opts.signal ? { signal: opts.signal } : undefined);
  const out: Tool[] = [];
  for (const name of WEB_TOOL_NAMES) {
    const info = list.find((t) => t.name === name);
    if (!info) continue;
    const isSearch = name === "web_search";
    out.push({
      name,
      description: info.description,
      parameters: (info.parameters ?? { type: "object", properties: {} }) as JSONSchema,
      readOnly: true,
      // A page may be long; web_fetch cuts it at its own max_chars (40 000 by default).
      maxResultChars: isSearch ? 16_000 : 42_000,
      ...(isSearch ? { guidelines: GUIDELINES } : {}),
      display: {
        icon: isSearch ? SEARCH_ICON : GLOBE_ICON,
        outcome: ({ details }) => {
          if (isSearch) {
            const n = (details as { results?: unknown[] } | undefined)?.results?.length;
            return typeof n === "number" ? String(n) : undefined;
          }
          const title = (details as { title?: string } | undefined)?.title;
          return title ? title.slice(0, 40) : undefined;
        },
      },
      async execute(args: Record<string, unknown>, ctx) {
        if (!isSearch && typeof args.url === "string") ctx.update(hostOf(args.url));
        const r = await platform.call(name, args, { signal: ctx.signal });
        const cost = r.usage?.total_cost;
        if (typeof cost === "number" && cost > 0) opts.onCost?.(cost);
        return { content: r.content, details: r.data };
      },
    });
  }
  return out;
}
