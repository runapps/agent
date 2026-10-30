// Prompt templates and skill invocation typed as slash commands, as in
// pi: `/name args` expands the workspace file /prompts/<name>.md with
// bash-style arguments ($1, $@, ${2:-default}, ${@:2}…); `/skill:name
// args` loads a skill's instructions for this prompt. The argument
// parsing and substitution are pi's (github.com/earendil-works/pi, MIT).

import type { Workspace } from "./workspace.js";

export const PROMPTS_ROOT = "/prompts";

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

/** Bash-style argument splitting: quotes group words, "" is an empty argument. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuote: string | null = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i]!;
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * `$1`…`$N`, `$@` / `$ARGUMENTS` (all), `${N:-default}`, `${@:-default}`,
 * `${@:N}` and `${@:N:L}` (slices). Values are not substituted again.
 */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget: string | undefined, defaultValue: string, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
      if (defaultTarget) {
        const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        let start = parseInt(sliceStart, 10) - 1;
        if (start < 0) start = 0;
        if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(" ");
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      return args[parseInt(simple!, 10) - 1] ?? "";
    },
  );
}

/** The templates under /prompts (name = file name without .md). */
export async function listTemplates(ws: Workspace): Promise<PromptTemplate[]> {
  const out: PromptTemplate[] = [];
  for (const f of await ws.list(PROMPTS_ROOT)) {
    if (!f.path.endsWith(".md")) continue;
    const name = f.path.slice(PROMPTS_ROOT.length + 1, -3);
    if (name.includes("/")) continue;
    let text: string;
    try {
      text = await ws.readText(f.path);
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(text);
    const description = fm.description || firstLine(body);
    out.push({ name, description, argumentHint: fm["argument-hint"], path: f.path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Expands a prompt that starts with `/`: `/skill:name args` → the skill's
 * instructions (as pi words them) plus the arguments; `/name args` → the
 * template's body with its placeholders filled. Anything else is
 * returned unchanged.
 */
export async function expandSlash(ws: Workspace | null, text: string): Promise<string> {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m || !ws) return text;
  const name = m[1]!;
  const argText = (m[2] ?? "").trim();
  if (name.startsWith("skill:")) {
    const skillName = name.slice(6);
    const skills = await ws.skills();
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) return text;
    const { body } = await ws.skillBody(skillName);
    const expanded = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.dir}.\n\n${body}\n</skill>`;
    return argText ? `${expanded}\n\n${argText}` : expanded;
  }
  const path = `${PROMPTS_ROOT}/${name}.md`;
  let source: string;
  try {
    source = await ws.readText(path);
  } catch {
    return text;
  }
  const { body } = splitFrontmatter(source);
  return substituteArgs(body, parseCommandArgs(argText));
}

function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { fm: {}, body: src.trim() };
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { fm, body: src.slice(m[0].length).trim() };
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? line.slice(0, 60) + "..." : line;
}
