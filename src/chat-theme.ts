// The chat's look as data: CSS custom properties (`--ra-*`) with a value
// for light and for dark, a few built-in palettes, and the per-instance
// overrides a host passes to renderChat. The rules in chat.ts only use
// these variables, so a palette or a host stylesheet restyles everything.

/** The colour tokens, as `--ra-<name>` custom properties on `.ra-chat`. */
export const CHAT_COLOR_TOKENS = [
  "bg", "panel", "subtle", "muted", "fg", "fg-muted", "border",
  "accent", "accent-fg", "accent-subtle", "accent-muted",
  "user-bg", "link", "ok", "red", "red-subtle",
  "warn-fg", "warn-bg", "warn-border", "shadow", "shadow-md",
] as const;
/** Tokens that are the same in light and dark: fonts. */
export const CHAT_SHARED_TOKENS = ["font", "mono"] as const;

export type ChatColorToken = (typeof CHAT_COLOR_TOKENS)[number];
export type ChatToken = ChatColorToken | (typeof CHAT_SHARED_TOKENS)[number];
/** Token values by name (`accent`) or full property (`--ra-accent`). */
export type ChatVars = Partial<Record<ChatToken | `--ra-${ChatToken}`, string>>;

/** A palette: its light and dark values (tokens it leaves out keep the default palette's). */
export interface ChatPalette {
  light: Partial<Record<ChatColorToken, string>>;
  dark: Partial<Record<ChatColorToken, string>>;
}

const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Noto Sans SC",Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

/** The built-in palettes; `claude` is the default and defines every token. */
export const CHAT_PALETTES: Record<"claude" | "violet" | "slate" | "forest", ChatPalette> = {
  // Ivory and warm charcoal, a coral accent, neutral user bubbles, blue links.
  claude: {
    light: {
      bg: "#faf9f5", panel: "#ffffff", subtle: "#f5f4ee", muted: "#f0eee6", fg: "#141413", "fg-muted": "#73726c", border: "#e5e3da",
      accent: "#d97757", "accent-fg": "#b85a3a", "accent-subtle": "#f7e8e1", "accent-muted": "#efcbbd",
      "user-bg": "#f0eee6", link: "#2b6cb0", ok: "#3d8b5a", red: "#b53333", "red-subtle": "#f9ebe9",
      "warn-fg": "#a15c07", "warn-bg": "#fdf6e7", "warn-border": "#f0d9a8",
      shadow: "0 1px 2px rgba(31,30,29,.06)", "shadow-md": "0 6px 20px rgba(31,30,29,.12),0 1px 3px rgba(31,30,29,.08)",
    },
    dark: {
      bg: "#262624", panel: "#30302e", subtle: "#2b2a28", muted: "#343432", fg: "#f5f4ee", "fg-muted": "#a3a19a", border: "#3d3d3a",
      accent: "#d97757", "accent-fg": "#e8957a", "accent-subtle": "rgba(217,119,87,.14)", "accent-muted": "rgba(217,119,87,.32)",
      "user-bg": "#1f1e1d", link: "#7aaeea", ok: "#6bbf86", red: "#e57373", "red-subtle": "rgba(229,115,115,.12)",
      "warn-fg": "#f0b45c", "warn-bg": "rgba(240,180,92,.08)", "warn-border": "rgba(240,180,92,.28)",
      shadow: "0 1px 2px rgba(0,0,0,.3)", "shadow-md": "0 6px 20px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.3)",
    },
  },
  // Cool grays and violet (the harness app's Chakra palette).
  violet: {
    light: {
      bg: "#ffffff", panel: "#ffffff", subtle: "#fafafa", muted: "#f4f4f5", fg: "#09090b", "fg-muted": "#52525b", border: "#e4e4e7",
      accent: "#9333ea", "accent-fg": "#7e22ce", "accent-subtle": "#f3e8ff", "accent-muted": "#e9d5ff",
      "user-bg": "#f3e8ff", link: "#7e22ce", ok: "#16a34a", red: "#dc2626", "red-subtle": "#fef2f2",
    },
    dark: {
      bg: "#09090b", panel: "#09090b", subtle: "#101014", muted: "#18181b", fg: "#fafafa", "fg-muted": "#a1a1aa", border: "#27272a",
      accent: "#9333ea", "accent-fg": "#d8b4fe", "accent-subtle": "#3b0764", "accent-muted": "#581c87",
      "user-bg": "#3b0764", link: "#d8b4fe", ok: "#4ade80", red: "#f87171", "red-subtle": "#2a1215",
    },
  },
  // Neutral grays and a blue accent.
  slate: {
    light: {
      bg: "#ffffff", panel: "#ffffff", subtle: "#f9f9f9", muted: "#f3f3f3", fg: "#0d0d0d", "fg-muted": "#5d5d5d", border: "#e5e5e5",
      accent: "#2563eb", "accent-fg": "#1d4ed8", "accent-subtle": "#eff4ff", "accent-muted": "#c7d7fe",
      "user-bg": "#f3f3f3", link: "#2563eb", ok: "#16a34a", red: "#dc2626", "red-subtle": "#fef2f2",
    },
    dark: {
      bg: "#212121", panel: "#2a2a2a", subtle: "#262626", muted: "#303030", fg: "#ececec", "fg-muted": "#a0a0a0", border: "#383838",
      accent: "#3b82f6", "accent-fg": "#93b4fd", "accent-subtle": "rgba(59,130,246,.15)", "accent-muted": "rgba(59,130,246,.35)",
      "user-bg": "#303030", link: "#7cacf8", ok: "#4ade80", red: "#f87171", "red-subtle": "rgba(248,113,113,.12)",
    },
  },
  // Soft green-grays and a green accent.
  forest: {
    light: {
      bg: "#fbfcfa", panel: "#ffffff", subtle: "#f5f7f3", muted: "#eef2eb", fg: "#14201a", "fg-muted": "#5f6b63", border: "#e1e7dd",
      accent: "#2f855a", "accent-fg": "#276749", "accent-subtle": "#e6f4ec", "accent-muted": "#b9e0c9",
      "user-bg": "#eef2eb", link: "#2b6cb0", ok: "#2f855a", red: "#c53030", "red-subtle": "#fdecec",
    },
    dark: {
      bg: "#1a201c", panel: "#222a25", subtle: "#1e2520", muted: "#283029", fg: "#eef3ee", "fg-muted": "#9aa79e", border: "#334037",
      accent: "#48bb78", "accent-fg": "#7fd3a2", "accent-subtle": "rgba(72,187,120,.14)", "accent-muted": "rgba(72,187,120,.32)",
      "user-bg": "#141a16", link: "#7aaeea", ok: "#68d391", red: "#fc8181", "red-subtle": "rgba(252,129,129,.12)",
    },
  },
};

const decl = (vals: Partial<Record<string, string>>) => Object.entries(vals).map(([k, v]) => `--ra-${k}:${v}`).join(";");

/**
 * The token rules. They sit in `:where()`, so they weigh nothing: a host
 * rule as plain as `.ra-chat { --ra-accent: … }` overrides them (and
 * `.ra-chat[data-scheme=dark] { … }` for dark only). Order matters among
 * them: default light, default dark, then each palette's light and dark.
 */
export function tokenCSS(): string {
  const base = CHAT_PALETTES.claude;
  const out = [
    `:where(.ra-chat){--ra-font:${FONT};--ra-mono:${MONO};${decl(base.light)}}`,
    `:where(.ra-chat[data-scheme=dark]){${decl(base.dark)};color-scheme:dark}`,
  ];
  for (const [name, p] of Object.entries(CHAT_PALETTES)) {
    if (name === "claude") continue;
    out.push(`:where(.ra-chat[data-palette=${name}]){${decl(p.light)}}`);
    out.push(`:where(.ra-chat[data-palette=${name}][data-scheme=dark]){${decl(p.dark)}}`);
  }
  return out.join("\n");
}

/** `accent` or `--ra-accent` → `--ra-accent`. */
export const tokenProp = (key: string): string => (key.startsWith("--") ? key : `--ra-${key}`);
