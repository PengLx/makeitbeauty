/**
 * Output sanitizer (architecture.md §5 step 5) — a SECURITY BOUNDARY, not a
 * linter. Runs on the FINAL composed SVG. Allowlist philosophy: only data:
 * URIs and #fragment references may appear; any external reference is rejected
 * because connector data + an attacker-chosen URL is an exfiltration beacon.
 * When in doubt, reject.
 */

export class SanitizeError extends Error {
  readonly code = "UNSAFE_SVG";
  constructor(reason: string) {
    super(`SVG rejected by sanitizer: ${reason}`);
    this.name = "SanitizeError";
  }
}

/**
 * Namespace declarations are identifiers, never fetched — the only http://
 * strings allowed to exist in output, and only as xmlns attribute values.
 */
const ALLOWED_NAMESPACES = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/XML/1998/namespace",
]);

const XMLNS_ATTR_RE = /\bxmlns(?::[a-zA-Z0-9_-]+)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const REF_ATTR_RE = /\b(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Validate the final SVG. Returns it unchanged on success; throws
 * SanitizeError on any violation (we reject rather than attempt repair —
 * repaired output would no longer be what the pipeline produced).
 */
export function sanitizeSvg(svg: string): string {
  if (/<\s*script\b/i.test(svg)) throw new SanitizeError("contains <script>");
  if (/<\s*foreignObject\b/i.test(svg)) throw new SanitizeError("contains <foreignObject>");
  if (/\son[a-zA-Z]+\s*=/i.test(svg)) throw new SanitizeError("contains an on* event-handler attribute");
  if (/javascript\s*:/i.test(svg)) throw new SanitizeError("contains a javascript: reference");

  // Every href/xlink:href/src must be a data: URI or an internal #fragment.
  for (const match of svg.matchAll(REF_ATTR_RE)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (!value.startsWith("data:") && !value.startsWith("#")) {
      throw new SanitizeError(`disallowed reference "${truncate(value)}" (only data: and #fragment pass)`);
    }
  }

  // Strip allowed xmlns declarations, then any surviving http(s):// anywhere
  // (style url(), CSS @import, text content smuggling, …) is a rejection.
  const stripped = svg.replace(XMLNS_ATTR_RE, (attr, dq, sq) =>
    ALLOWED_NAMESPACES.has(dq ?? sq) ? "" : attr,
  );
  if (/https?:\/\//i.test(stripped)) {
    throw new SanitizeError("contains an external http(s) URL reference");
  }

  return svg;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
