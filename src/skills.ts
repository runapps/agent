// Skills: folders with a SKILL.md whose frontmatter names and describes
// them (the Agent Skills format pi uses). The model sees name +
// description in the system prompt and reads the body on demand.

import type { Skill } from "./types.js";

export const MAX_SKILL_DESCRIPTION = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedSkill {
  skill: Skill;
  /** The instructions after the frontmatter. */
  body: string;
  warnings: string[];
}

/**
 * Parses a SKILL.md. `path` is where it sits in the workspace; the folder
 * name is the fallback for a missing `name`. Returns null when the file
 * has no usable description (such a skill is not loaded).
 */
export function parseSkill(text: string, path: string): ParsedSkill | null {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const dir = path.replace(/\/[^/]*$/, "") || "/";
  const folder = dir.split("/").filter(Boolean).pop() ?? "skill";
  const warnings: string[] = [];
  let fm: Record<string, string> = {};
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    fm = parseFrontmatter(m[1] ?? "");
    body = src.slice(m[0].length);
  }
  const description = (fm.description ?? "").trim();
  if (!description) return null;
  let name = (fm.name ?? "").trim() || folder;
  if (!NAME_RE.test(name) || name.length > 64) {
    warnings.push(`skill name "${name}" is not lowercase-hyphenated (≤64); using the folder name`);
    name = NAME_RE.test(folder) ? folder : folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  }
  const skill: Skill = {
    name,
    description: description.length > MAX_SKILL_DESCRIPTION ? description.slice(0, MAX_SKILL_DESCRIPTION) : description,
    path,
    dir,
  };
  if (description.length > MAX_SKILL_DESCRIPTION) warnings.push(`description of "${name}" cut to ${MAX_SKILL_DESCRIPTION} characters`);
  if (/^(true|yes)$/i.test(fm["disable-model-invocation"] ?? "")) skill.disableModelInvocation = true;
  if (fm.license) skill.license = fm.license;
  if (fm.compatibility) skill.compatibility = fm.compatibility;
  if (fm["allowed-tools"]) skill.allowedTools = fm["allowed-tools"].split(/[\s,]+/).filter(Boolean);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) if (k.startsWith("metadata.")) meta[k.slice(9)] = v;
  if (Object.keys(meta).length) skill.metadata = meta;
  return { skill, body: body.trim(), warnings };
}

/**
 * The YAML subset frontmatter uses: `key: value` lines, quoted or plain
 * scalars, one level of nesting under `metadata:` (flattened to
 * `metadata.key`), `>`/`|` block scalars for long descriptions.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  let i = 0;
  let parent = "";
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = indent > 0 && parent ? `${parent}.${m[1]}` : m[1]!;
    if (indent === 0) parent = "";
    let value = m[2] ?? "";
    if (value === "" ) {
      // Either a nested map or an empty value.
      const next = lines[i] ?? "";
      if (next.length - next.trimStart().length > indent && next.trim()) {
        parent = m[1]!;
        continue;
      }
    } else if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const fold = value.startsWith(">");
      const block: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() && l.length - l.trimStart().length <= indent) break;
        block.push(l.trim());
        i++;
      }
      value = fold ? block.join(" ").trim() : block.join("\n").trim();
    } else {
      value = unquote(value);
    }
    out[key] = value;
  }
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return t.replace(/\s+#.*$/, "");
}
