/**
 * Pulls the first JSON value out of a model reply. Handles ```json fences, <think> blocks,
 * chatter around the JSON, trailing commas and replies that were cut off mid-array.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^﻿/, '').trim();
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(cleaned);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct.ok) return direct.value;
    const scanned = scan(candidate);
    if (scanned !== undefined) return scanned;
  }
  throw new Error('The AI reply did not contain any JSON.');
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(repair(s)) };
    } catch {
      return { ok: false };
    }
  }
}

/** Removes trailing commas and // line comments, which models love to add. */
function repair(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1').replace(/^\s*\/\/.*$/gm, '');
}

function scan(s: string): unknown {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  // Last spot where an element inside an array finished, with the brackets still open there.
  let lastSafe: { end: number; open: string[] } | null = null;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        const parsed = tryParse(s.slice(start, i + 1));
        if (parsed.ok) return parsed.value;
        break;
      }
      if (ch === '}' && stack[stack.length - 1] === '[') lastSafe = { end: i + 1, open: [...stack] };
    }
  }

  // Truncated reply: close everything after the last complete array element.
  if (lastSafe) {
    const closers = lastSafe.open
      .reverse()
      .map((c) => (c === '{' ? '}' : ']'))
      .join('');
    const parsed = tryParse(s.slice(start, lastSafe.end) + closers);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}
