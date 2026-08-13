/**
 * Client-side knowledge about CONFIG-TIER connectors (architecture.md §6,
 * auth tiers none/api_key): the ones a user configures by submitting a small
 * config object to PUT /v1/connectors/{name}/account. GitHub is deliberately
 * absent — login is its provisioning path, so its DataDialog row is a hint,
 * not a form.
 *
 * Validation here mirrors the server's rules purely for instant feedback;
 * the API remains the authority and its error envelope surfaces inline when
 * the two ever disagree.
 */

export interface ConnectorConfigSpec {
  /** The config object's single JSON key (strict-decoded server-side). */
  field: "apiKey" | "username" | "feedUrl";
  /** Input label, e.g. "API key". */
  label: string;
  /** HTML input type; "password" keeps credentials off the screen. */
  inputType: "password" | "text" | "url";
  placeholder: string;
  /** One line under the input saying where the value comes from / its shape. */
  hint: string;
  /** Mirror of the server validation; returns a message, or null when valid. */
  validate: (value: string) => string | null;
  /**
   * Non-secret display hint derived from a just-submitted value (the API
   * never echoes config back), remembered locally for the connected summary.
   * MUST return null for credentials — an API key is never persisted
   * client-side in any form.
   */
  hintFromValue: (value: string) => string | null;
  /** Connected-row summary, given the remembered hint (null when unknown). */
  summary: (hint: string | null) => string;
}

/** LeetCode's public username shape (mirrors the API's account validation). */
const LEETCODE_USERNAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Host of an absolute https URL, or null when the string is anything else
 * (relative, http, unparsable). Doubles as the rss validity check and the
 * connected-summary display value ("blog.example.com").
 */
export function feedHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" && parsed.host !== "" ? parsed.host : null;
}

const SPECS: Record<string, ConnectorConfigSpec> = {
  wakatime: {
    field: "apiKey",
    label: "API key",
    inputType: "password",
    placeholder: "waka_…",
    hint: "wakatime.com → Settings → Account → Secret API Key.",
    validate: (value) =>
      value === "" ? "Enter your WakaTime API key." : null,
    hintFromValue: () => null, // credential — never remembered
    summary: () => "API key set",
  },
  leetcode: {
    field: "username",
    label: "Username",
    inputType: "text",
    placeholder: "your-leetcode-username",
    hint: "Public profile stats — no password involved.",
    validate: (value) =>
      LEETCODE_USERNAME_RE.test(value)
        ? null
        : "Usernames are 1–40 characters: letters, digits, - or _.",
    hintFromValue: (value) => value,
    summary: (hint) => hint ?? "Username set",
  },
  rss: {
    field: "feedUrl",
    label: "Feed URL",
    inputType: "url",
    placeholder: "https://example.com/feed.xml",
    hint: "Absolute https:// URL of an RSS or Atom feed.",
    validate: (value) =>
      feedHost(value) === null
        ? "Enter an absolute https:// feed URL."
        : null,
    hintFromValue: (value) => feedHost(value),
    summary: (hint) => hint ?? "Feed configured",
  },
};

/** Spec for a config-tier connector; null for OAuth-tier (github) / unknown. */
export function accountConfigSpec(
  connector: string,
): ConnectorConfigSpec | null {
  return SPECS[connector] ?? null;
}

// ---- remembered display hints --------------------------------------------
// The API seals config at rest and never echoes it, so the connected summary
// ("liu2248" / "blog.example.com") relies on a locally remembered, NON-SECRET
// hint captured at connect time. Best-effort localStorage: private mode or
// another device simply degrades to the spec's generic summary.

const HINT_PREFIX = "mib.connectorHint.";

export function rememberAccountHint(
  connector: string,
  hint: string | null,
): void {
  try {
    if (hint === null || hint === "") {
      localStorage.removeItem(HINT_PREFIX + connector);
    } else {
      localStorage.setItem(HINT_PREFIX + connector, hint);
    }
  } catch {
    /* storage unavailable — summary falls back to generic text */
  }
}

export function recallAccountHint(connector: string): string | null {
  try {
    return localStorage.getItem(HINT_PREFIX + connector);
  } catch {
    return null;
  }
}

export function forgetAccountHint(connector: string): void {
  rememberAccountHint(connector, null);
}
