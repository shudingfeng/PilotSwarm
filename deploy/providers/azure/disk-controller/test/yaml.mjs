// A reader for the YAML that the controller's manifests use, so their tests
// need no npm package and no kubectl: block mappings and sequences, plain and
// quoted scalars, empty or simple flow collections, block scalars (`|`, `|-`,
// `>`) and comments. Anything else throws, so a manifest that outgrows it
// fails loudly instead of being misread.

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function blank(line) {
  return /^\s*(?:#.*)?$/.test(line);
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function splitFlow(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" || c === "{") {
      depth += 1;
    } else if (c === "]" || c === "}") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function scalar(text) {
  const value = text.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`unterminated string: ${value}`);
    return JSON.parse(value);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`unterminated string: ${value}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`unsupported flow sequence: ${value}`);
    return splitFlow(value.slice(1, -1)).map(scalar);
  }
  if (value.startsWith("{")) {
    if (!value.endsWith("}")) throw new Error(`unsupported flow mapping: ${value}`);
    return Object.fromEntries(splitFlow(value.slice(1, -1)).map((entry) => {
      const at = entry.indexOf(":");
      if (at < 0) throw new Error(`unsupported flow mapping entry: ${entry}`);
      return [scalar(entry.slice(0, at)), scalar(entry.slice(at + 1))];
    }));
  }
  if (/^[&*!|>%@`]/.test(value)) throw new Error(`unsupported YAML: ${value}`);
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^:#]*?)\s*:(?:\s+(.*))?$/;

function parseLines(lines) {
  let i = 0;
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i += 1;
  };

  function blockScalar(header, parentIndent) {
    const folded = header.startsWith(">");
    const strip = header.includes("-");
    const out = [];
    let indent = null;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        out.push("");
        i += 1;
        continue;
      }
      const at = indentOf(line);
      if (at <= parentIndent || (indent !== null && at < indent)) break;
      indent ??= at;
      out.push(line.slice(indent));
      i += 1;
    }
    while (out.length && out.at(-1) === "") out.pop();
    const text = folded ? out.join(" ").replace(/ {2,}/g, " ") : out.join("\n");
    return strip || !text ? text : `${text}\n`;
  }

  function value(rest, indent) {
    if (rest === "") {
      skip();
      if (i < lines.length) {
        const at = indentOf(lines[i]);
        const text = lines[i].slice(at);
        if (at > indent) return node(at);
        if (at === indent && /^-(?:\s|$)/.test(text)) return sequence(at);
      }
      return null;
    }
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest, indent);
    return scalar(rest);
  }

  function mapping(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== indent) break;
      const text = stripComment(lines[i].slice(indent));
      if (/^-(?:\s|$)/.test(text)) break;
      const match = KEY.exec(text);
      if (!match) throw new Error(`cannot read line ${i + 1}: ${lines[i]}`);
      const key = String(scalar(match[1]));
      if (Object.hasOwn(out, key)) throw new Error(`duplicate key ${key} at line ${i + 1}`);
      i += 1;
      out[key] = value((match[2] ?? "").trim(), indent);
    }
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== indent) break;
      const line = lines[i];
      if (!/^-(?:\s|$)/.test(line.slice(indent))) break;
      const after = line.slice(indent + 1);
      const content = stripComment(after).trim();
      if (content === "") {
        i += 1;
        out.push(node(indent + 1));
      } else if (KEY.test(content) && !/^["'[{]/.test(content)) {
        // `- key: value` starts a mapping at the column of `key`.
        const column = indent + 1 + indentOf(after);
        lines[i] = " ".repeat(column) + after.trimStart();
        out.push(mapping(column));
      } else if (/^[|>][-+]?$/.test(content)) {
        i += 1;
        out.push(blockScalar(content, indent));
      } else {
        i += 1;
        out.push(scalar(content));
      }
    }
    return out;
  }

  function node(indent) {
    skip();
    if (i >= lines.length) return null;
    const at = indentOf(lines[i]);
    if (at < indent) return null;
    return /^-(?:\s|$)/.test(lines[i].slice(at)) ? sequence(at) : mapping(at);
  }

  const result = node(0);
  skip();
  if (i < lines.length) throw new Error(`cannot read line ${i + 1}: ${lines[i]}`);
  return result;
}

/** Every document in a YAML stream, in order; empty documents are dropped. */
export function parseYamlDocuments(text) {
  const documents = [];
  let current = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^---\s*$/.test(line)) {
      documents.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  documents.push(current);
  return documents.filter((lines) => lines.some((line) => !blank(line))).map(parseLines);
}

/** The single document of a YAML file. */
export function parseYaml(text) {
  const documents = parseYamlDocuments(text);
  if (documents.length !== 1) throw new Error(`expected one YAML document, found ${documents.length}`);
  return documents[0];
}
