// Exact-text file edits with pi's matching rules (github.com/earendil-
// works/pi, MIT): several disjoint replacements in one call, matched
// against the original text; an exact match first, else a normalised
// match (NFKC, trailing whitespace, smart quotes, dashes, odd spaces) so
// a model's slightly different quoting still lands; and its error
// messages, which tell the model what to fix.

export interface TextEdit {
  oldText: string;
  newText: string;
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(content: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = content.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/**
 * Applies `edits` to `content`. Each oldText must occur exactly once and
 * the matches must not overlap. Returns the new content; throws with
 * pi's wording when an edit cannot be applied.
 */
export function applyEdits(path: string, content: string, edits: TextEdit[]): string {
  if (!edits.length) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  const many = edits.length > 1;
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const crlf = /\r\n/.test(content);
  const original = content.slice(bom.length).replace(/\r\n/g, "\n");

  // Exact matching first; when any edit needs it, match all of them on the normalised text.
  let haystack = original;
  let needsFuzzy = false;
  for (const e of edits) {
    if (!e.oldText) continue;
    if (!original.includes(e.oldText.replace(/\r\n/g, "\n"))) {
      needsFuzzy = true;
      break;
    }
  }
  if (needsFuzzy) haystack = normalizeForFuzzyMatch(original);

  const spans: Array<{ start: number; end: number; newText: string; i: number }> = [];
  edits.forEach((e, i) => {
    const oldText = e.oldText.replace(/\r\n/g, "\n");
    if (!oldText) throw new Error(many ? `edits[${i}].oldText must not be empty in ${path}.` : `oldText must not be empty in ${path}.`);
    const needle = needsFuzzy ? normalizeForFuzzyMatch(oldText) : oldText;
    const count = countOccurrences(haystack, needle);
    if (count === 0) {
      throw new Error(many
        ? `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
        : `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);
    }
    if (count > 1) {
      throw new Error(many
        ? `Found ${count} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`
        : `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`);
    }
    const start = haystack.indexOf(needle);
    spans.push({ start, end: start + needle.length, newText: e.newText.replace(/\r\n/g, "\n"), i });
  });
  spans.sort((a, b) => a.start - b.start);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k]!.start < spans[k - 1]!.end) {
      throw new Error(`edits[${spans[k - 1]!.i}] and edits[${spans[k]!.i}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += haystack.slice(pos, s.start) + s.newText;
    pos = s.end;
  }
  out += haystack.slice(pos);
  if (out === haystack) {
    throw new Error(many
      ? `No changes made to ${path}. The replacements produced identical content.`
      : `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
  }
  return bom + (crlf ? out.replace(/\n/g, "\r\n") : out);
}
