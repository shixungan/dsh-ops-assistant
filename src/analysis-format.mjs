const structural = new Set(["{", "}", "[", "]", ":", ","]);
const whitespace = (character) =>
  character === " " || character === "\t" || character === "\r" || character === "\n";

function unfence(text) {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s([\s\S]*?)\s*```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

// The caller validates repaired as a complete JSON report first. Follow its
// string boundaries, since the original may contain unescaped inner quotes.
// Allow punctuation insertions, never replacement/removal of report content.
export function assertFormatOnly(original, repaired) {
  const fail = () => {
    throw new Error("格式修正改变了原回复内容，未采用修正结果");
  };
  if (typeof original !== "string" || typeof repaired !== "string") fail();
  const source = unfence(original);
  const target = unfence(repaired);
  let offset = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < target.length; i++) {
    const character = target[i];
    if (!inString) {
      while (whitespace(source[offset])) offset++;
      if (whitespace(character)) continue;
    }
    if (character === source[offset]) {
      offset++;
    } else if (!inString && structural.has(character)) {
      // Insert a missing array/object delimiter, colon, or comma.
    } else if (
      inString && !escaped && character === "\\" &&
      target[i + 1] === '"' && source[offset] === '"'
    ) {
      // Escape an existing quote; the next iteration must consume that quote.
    } else {
      fail();
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    }
  }
  if (inString || escaped) fail();
  while (whitespace(source[offset])) offset++;
  if (offset !== source.length) fail();
}
