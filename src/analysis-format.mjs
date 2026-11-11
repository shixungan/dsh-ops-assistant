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

// Recognize only a complete PromQL label selector inside an already-open JSON
// value string. General quote guessing can merge distinct array items or turn
// JSON keys into evidence, so it is intentionally not supported here.
function quotedSelector(source, start) {
  let offset = start + 1;
  let result = "{";
  const spaces = () => {
    while (source[offset] === " ") result += source[offset++];
  };
  for (;;) {
    spaces();
    const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(offset));
    if (!name) return null;
    result += name[0];
    offset += name[0].length;
    spaces();
    const operator = /^(?:=~|!~|!=|=)/.exec(source.slice(offset));
    if (!operator) return null;
    result += operator[0];
    offset += operator[0].length;
    spaces();
    const escaped = source.startsWith('\\"', offset);
    if (!escaped && source[offset] !== '"') return null;
    const delimiter = escaped ? '\\"' : '"';
    offset += delimiter.length;
    result += '\\"';
    const valueStart = offset;
    while (!source.startsWith(delimiter, offset)) {
      const character = source[offset];
      // Values containing their own escapes or bracket syntax are ambiguous
      // here; an already-valid JSON string is handled by the normal parser.
      if (character === undefined || /[\\"{}\[\]\x00-\x1f]/.test(character)) return null;
      offset++;
    }
    result += source.slice(valueStart, offset) + '\\"';
    offset += delimiter.length;
    spaces();
    if (source[offset] === "}") return { text: result + "}", end: offset + 1 };
    if (source[offset] !== ",") return null;
    result += source[offset++];
  }
}

// Deterministic, insertion-only repair: complete values may be missing closing
// containers, but never infer a value, string delimiter, key, comma or colon.
// The caller still validates the analysis schema and exact alert-ID coverage.
export function repairAnalysisJson(text) {
  if (typeof text !== "string" || text.length > 1000000) return null;
  const source = unfence(text);
  let offset = 0;
  const output = [];
  const fail = () => { throw new SyntaxError("无法安全修正 JSON 格式"); };
  const copy = (length = 1) => {
    output.push(source.slice(offset, offset + length));
    offset += length;
  };
  const spaces = () => {
    const start = offset;
    while (whitespace(source[offset])) offset++;
    output.push(source.slice(start, offset));
  };
  const string = (key) => {
    if (source[offset] !== '"') fail();
    copy();
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') { copy(); return; }
      if (character === "\\") {
        const escape = /^\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/.exec(source.slice(offset));
        if (!escape) fail();
        copy(escape[0].length);
      } else if (character.charCodeAt(0) < 0x20) fail();
      else {
        const selector = !key && character === "{" ? quotedSelector(source, offset) : null;
        if (selector) {
          output.push(selector.text);
          offset = selector.end;
        } else copy();
      }
    }
    fail();
  };
  const value = (ancestors) => {
    if (ancestors.length > 100) fail();
    spaces();
    const character = source[offset];
    if (character === '"') return string(false);
    if (character === "{" || character === "[") {
      const object = character === "{";
      const closing = object ? "}" : "]";
      copy();
      spaces();
      if (source[offset] === closing) { copy(); return; }
      for (;;) {
        if (object) {
          string(true);
          spaces();
          if (source[offset] !== ":") fail();
          copy();
        }
        value([...ancestors, closing]);
        spaces();
        if (source[offset] === closing) { copy(); return; }
        // Only close a container after a fully parsed value, either at EOF or
        // before an existing ancestor terminator. A trailing comma never enters
        // this branch, nor does a missing/unfinished value.
        if (offset === source.length || ancestors.includes(source[offset])) {
          output.push(closing);
          return;
        }
        if (source[offset] !== ",") fail();
        copy();
        spaces();
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!primitive) fail();
    copy(primitive[0].length);
  };
  try {
    // Valid replies retain their exact representation, including escaping.
    try { JSON.parse(source); return source; } catch { /* Try bounded repair. */ }
    value([]);
    spaces();
    if (offset !== source.length) return null;
    const repaired = output.join("");
    JSON.parse(repaired);
    assertFormatOnly(text, repaired);
    return repaired;
  } catch {
    return null;
  }
}
