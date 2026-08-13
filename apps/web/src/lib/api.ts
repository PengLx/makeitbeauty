/**
 * Typed client for the public API plane (apps/api, :7800 — reached via the
 * dev-server /v1 proxy, see vite.config.ts). Shapes follow the data model and
 * routes in docs/architecture.md §7–§8.
 *
 * Every failure throws ApiError carrying the server's {error:{code,message}}
 * envelope (or a synthesized code for transport/parse failures), so views can
 * surface it as an inline alert without re-parsing responses.
 */

import type { DesignDoc } from "./design";
import { isComponentDefinition, type ComponentDefinition } from "./component";
import type { CommunitySort } from "./paletteMenu";

export interface Binding {
  connector: string;
  accountId?: string;
  fields: string[];
}

export interface Output {
  id: string;
  /** auto|light|dark; "" / absent means auto. */
  theme?: string;
  format?: string;
  filename: string;
}

export interface Project {
  id: string;
  name: string;
  design: DesignDoc;
  bindings: Binding[];
  outputs: Output[];
  createdAt: string;
  updatedAt: string;
}

/** Masked deploy token from the GET list — the plaintext is never retrievable. */
export interface DeployTokenInfo {
  id: string;
  createdAt: string;
  revokedAt?: string | null;
}

/** POST response: `token` appears here ONCE; only its hash is stored. */
export interface CreatedDeployToken {
  id: string;
  token: string;
  createdAt: string;
}

export class ApiError extends Error {
  readonly code: string;
  /** HTTP status; 0 for transport-level failures that never got a response. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** Normalize unknown throwables (fetch rejections etc.) into ApiError. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(
    "network_error",
    e instanceof Error ? e.message : String(e),
    0,
  );
}

/** Core fetch + §8 error-envelope handling. Empty bodies resolve undefined. */
async function request<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw toApiError(e);
  }

  const text = await res.text();
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; message?: string };
      };
      if (parsed?.error?.code) {
        code = parsed.error.code;
        message = parsed.error.message ?? message;
      }
    } catch {
      /* non-JSON error body; keep the http_* fallback */
    }
    throw new ApiError(code, message, res.status);
  }

  if (text === "") return undefined as T; // 204-style responses (DELETE)
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("invalid_response", "API returned malformed JSON", res.status);
  }
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

// ---- session & connectors (architecture §8) -----------------------------

/** Signed-in user, per the §7 data model (avatarUrl is an optional extra). */
export interface User {
  id: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface ConnectorSummary {
  connector: string;
  status: ConnectorStatus;
}

/** GET /v1/me body; `dev` flags the MIB_ENV=dev implicit-user fallback. */
export interface Me {
  user: User;
  connectors: ConnectorSummary[];
  dev?: boolean;
}

export type ConnectorStatus = "connected" | "unconfigured" | "expired";

/**
 * One bindable snapshot field, e.g. {path: "user.followers", …}. Paths are
 * relative to the connector; qualify with the connector name to build a
 * template (see qualifyPath in BindingControl). `type` drives the editor's
 * binding controls: a number input only offers number fields (§8).
 *
 * Beyond the template-bindable primitives, catalogs also carry structured
 * fields ("series": github stats.calendar, wakatime stats.days, rss posts)
 * consumed by native kit components — pickers list primitives only, since a
 * {{template}} of a series can only resolve to a placeholder. Kept open so
 * future field types degrade to "not offered" instead of breaking parses.
 */
export interface ConnectorField {
  path: string;
  description?: string;
  type: "string" | "number" | "series" | (string & {});
}

export interface ConnectorInfo {
  connector: string;
  status: ConnectorStatus;
  fields: ConnectorField[];
}

/** Resolves the session (or throws ApiError with status 401 when signed out). */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request("/v1/me", { signal });
}

export function logout(): Promise<void> {
  return send("POST", "/v1/auth/logout");
}

export async function listConnectors(
  signal?: AbortSignal,
): Promise<ConnectorInfo[]> {
  const body = await request<{ connectors?: ConnectorInfo[] } | ConnectorInfo[]>(
    "/v1/connectors",
    { signal },
  );
  return Array.isArray(body) ? body : (body.connectors ?? []);
}

/**
 * GET /v1/connectors/data — the session user's merged UNFILTERED connector
 * snapshots, keyed by connector name ({"github": {...}}). Powers the canvas's
 * live-data display; a connector whose upstream failed is simply absent.
 */
export function getConnectorData(
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return request("/v1/connectors/data", { signal });
}

/**
 * PUT /v1/connectors/{name}/account — configure a config-tier connector
 * (§6 auth tiers none/api_key: wakatime {apiKey}, leetcode {username},
 * rss {feedUrl}). The API strict-decodes and validates the config, seals it
 * at rest, and reports the connector's new status. GitHub is 400 here —
 * login is its provisioning path.
 */
export function putConnectorAccount(
  name: string,
  config: Record<string, string>,
): Promise<ConnectorSummary> {
  return send("PUT", `/v1/connectors/${encodeURIComponent(name)}/account`, config);
}

/**
 * DELETE /v1/connectors/{name}/account — disconnect: removes the account
 * and its sealed config; the connector reverts to "unconfigured".
 * Idempotent (204 either way).
 */
export function deleteConnectorAccount(name: string): Promise<void> {
  return send("DELETE", `/v1/connectors/${encodeURIComponent(name)}/account`);
}

// ---- project CRUD (architecture §8) -------------------------------------

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const body = await request<{ projects?: Project[] } | Project[]>(
    "/v1/projects",
    { signal },
  );
  return Array.isArray(body) ? body : (body.projects ?? []);
}

export function getProject(id: string, signal?: AbortSignal): Promise<Project> {
  return request(`/v1/projects/${encodeURIComponent(id)}`, { signal });
}

/**
 * Create a project. `design` is deliberately optional: the API defaults it
 * (blank canvas) — the client does not special-case this.
 */
export function createProject(req: {
  name: string;
  id?: string;
  design?: DesignDoc;
}): Promise<Project> {
  return send("POST", "/v1/projects", req);
}

export interface ProjectPatch {
  name?: string;
  design?: DesignDoc;
  bindings?: Binding[];
  outputs?: Output[];
}

export function updateProject(id: string, patch: ProjectPatch): Promise<Project> {
  return send("PUT", `/v1/projects/${encodeURIComponent(id)}`, patch);
}

export function deleteProject(id: string): Promise<void> {
  return send("DELETE", `/v1/projects/${encodeURIComponent(id)}`);
}

// ---- community components (architecture §7.5 + §8) ----------------------

/**
 * Registry metadata for one user component (§7.5 data model). latestVersion 0
 * means never published — a private draft. Server routes may attach the draft
 * and/or latest published definition; toComponentRecord normalizes either
 * spelling so views never re-parse response shapes.
 */
export interface ComponentRecord {
  /** "{owner}/{name}" — namespace is the owner's GitHub login, lowercased. */
  id: string;
  title: string;
  description?: string;
  /** Palette-menu category slug; absent = uncategorized ("other" group). */
  category?: string;
  latestVersion: number;
  unlisted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Frame size when the route carries it at the metadata level. */
  frame?: { w: number; h: number };
  /** The mutable draft definition (owner-only routes). */
  draft?: ComponentDefinition | null;
  /** The latest published definition (public once published). */
  definition?: ComponentDefinition | null;
  /**
   * Community enrichments (§8): distinct projects referencing the component
   * and its favorite total. Browse and the favorites list always carry them;
   * other routes (e.g. GET /v1/components) omit them — absent means "the
   * route doesn't serve counts", not zero, so views skip rather than show 0.
   */
  usageCount?: number;
  favoriteCount?: number;
}

/** One community browse hit (GET /v1/community/components). */
export interface CommunityComponent {
  id: string;
  owner: string;
  title: string;
  description?: string;
  /** Palette-menu category slug; also a click-to-filter facet in the palette. */
  category?: string;
  latestVersion: number;
  updatedAt?: string;
  /** Latest publish time — the "newest" ordering key (§8 browse contract). */
  publishedAt?: string;
  /** Distinct projects currently referencing the component (§8 usage). */
  usageCount?: number;
  favoriteCount?: number;
  /** Whether the session user favorited it; absent on anonymous browse. */
  favorited?: boolean;
}

/**
 * Defensive normalization of component-record responses. The §8 contract
 * fixes routes and the §7.5 data model, but not the response envelope; this
 * accepts the record bare or under {component}, with the version count as
 * latestVersion|version and definitions as draft|definition.
 */
function toComponentRecord(body: unknown): ComponentRecord {
  const root = (body ?? {}) as Record<string, unknown>;
  const raw = (
    typeof root.component === "object" && root.component !== null
      ? root.component
      : root
  ) as Record<string, unknown>;
  const draft = isComponentDefinition(raw.draft) ? raw.draft : null;
  const definition = isComponentDefinition(raw.definition) ? raw.definition : null;
  const frame = raw.frame as { w?: unknown; h?: unknown } | undefined;
  return {
    frame:
      typeof frame?.w === "number" && typeof frame?.h === "number"
        ? { w: frame.w, h: frame.h }
        : undefined,
    id: String(raw.id ?? ""),
    title: String(raw.title ?? raw.id ?? ""),
    description: typeof raw.description === "string" ? raw.description : undefined,
    // The API omits an unset category ("" never appears on the wire), but an
    // older/other server sending "" must still mean "uncategorized".
    category:
      typeof raw.category === "string" && raw.category !== ""
        ? raw.category
        : undefined,
    latestVersion:
      typeof raw.latestVersion === "number"
        ? raw.latestVersion
        : typeof raw.version === "number"
          ? raw.version
          : 0,
    unlisted: raw.unlisted === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    usageCount: typeof raw.usageCount === "number" ? raw.usageCount : undefined,
    favoriteCount:
      typeof raw.favoriteCount === "number" ? raw.favoriteCount : undefined,
    draft,
    definition,
  };
}

function componentPath(owner: string, name: string, suffix = ""): string {
  return `/v1/components/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

/** GET /v1/components — my components: drafts + published (session). */
export async function listMyComponents(
  signal?: AbortSignal,
): Promise<ComponentRecord[]> {
  const body = await request<{ components?: unknown[] } | unknown[]>(
    "/v1/components",
    { signal },
  );
  const items = Array.isArray(body) ? body : (body.components ?? []);
  return items.map(toComponentRecord);
}

/** POST /v1/components → a fresh draft; id = "{login}/{name}". */
export async function createComponent(req: {
  name: string;
  title: string;
  frame: { w: number; h: number };
}): Promise<ComponentRecord> {
  return toComponentRecord(await send("POST", "/v1/components", req));
}

/** GET /v1/components/{owner}/{name} — metadata + definitions. */
export async function getComponent(
  owner: string,
  name: string,
  signal?: AbortSignal,
): Promise<ComponentRecord> {
  return toComponentRecord(
    await request(componentPath(owner, name), { signal }),
  );
}

/**
 * PUT /v1/components/{owner}/{name} — replace the mutable draft (owner only).
 * The body is the definition's own fields, flattened
 * ({id?, title, description?, frame, props?, nodes?, computed?}) — the API
 * strict-decodes and rejects unknown fields, so no {definition} wrapper.
 */
export async function updateComponent(
  owner: string,
  name: string,
  definition: ComponentDefinition,
): Promise<ComponentRecord> {
  return toComponentRecord(
    await send("PUT", componentPath(owner, name), {
      id: definition.id,
      title: definition.title,
      // undefined serializes away; "" is a valid "no description".
      description: definition.description,
      // Optional palette-menu slug; undefined/"" both mean "clear it".
      category: definition.category,
      // §7.6 code surface: kind rides only when set; the API forbids `code`
      // (even "") unless kind is "code", so it serializes away otherwise.
      kind: definition.kind,
      code: definition.kind === "code" ? definition.code : undefined,
      frame: definition.frame,
      props: definition.props,
      nodes: definition.nodes,
      computed: definition.computed,
    }),
  );
}

/**
 * POST /v1/components/{owner}/{name}/publish — freezes the next immutable
 * version after renderer validation; validation failures surface verbatim as
 * ApiError. Resolves the published version number; if the response shape
 * doesn't carry one, re-reads the record (self-healing against envelope
 * drift).
 */
export async function publishComponent(
  owner: string,
  name: string,
): Promise<number> {
  const body = await send<unknown>("POST", componentPath(owner, name, "/publish"));
  const record = toComponentRecord(body);
  if (record.latestVersion > 0) return record.latestVersion;
  return (await getComponent(owner, name)).latestVersion;
}

/** Normalize one browse/favorites row into a CommunityComponent. */
function toCommunityComponent(item: unknown): CommunityComponent {
  const record = toComponentRecord(item);
  const raw = (item ?? {}) as Record<string, unknown>;
  return {
    id: record.id,
    owner:
      typeof raw.owner === "string" ? raw.owner : record.id.split("/")[0] ?? "",
    title: record.title,
    description: record.description,
    category: record.category,
    latestVersion: record.latestVersion,
    updatedAt: record.updatedAt,
    publishedAt:
      typeof raw.publishedAt === "string" ? raw.publishedAt : undefined,
    usageCount: record.usageCount,
    favoriteCount: record.favoriteCount,
    favorited: typeof raw.favorited === "boolean" ? raw.favorited : undefined,
  };
}

/**
 * GET /v1/community/components?q=&category=&sort= — published components
 * (public). `q` substring-matches id/title/description server-side;
 * `category` is an exact slug facet; both compose (AND). `sort` picks the
 * ordering — newest (default) | uses | favorites; the default is omitted
 * from the URL so cached/logged requests stay canonical.
 */
export async function listCommunity(
  q: string,
  category?: string,
  sort?: CommunitySort,
  signal?: AbortSignal,
): Promise<CommunityComponent[]> {
  const params = new URLSearchParams();
  if (q.trim() !== "") params.set("q", q.trim());
  if (category) params.set("category", category);
  if (sort && sort !== "newest") params.set("sort", sort);
  const qs = params.toString();
  const body = await request<{ components?: unknown[] } | unknown[]>(
    `/v1/community/components${qs === "" ? "" : `?${qs}`}`,
    { signal },
  );
  const items = Array.isArray(body) ? body : (body.components ?? []);
  return items.map(toCommunityComponent);
}

// ---- favorites (architecture §8) -----------------------------------------

/**
 * PUT /v1/components/{owner}/{name}/favorite — idempotent 204 (session).
 * 404 covers unknown, never-published, and unlisted-to-non-owners alike.
 */
export function favoriteComponent(owner: string, name: string): Promise<void> {
  return send("PUT", componentPath(owner, name, "/favorite"));
}

/**
 * DELETE /v1/components/{owner}/{name}/favorite — idempotent and
 * component-blind 204: "not favorited" is always reachable.
 */
export function unfavoriteComponent(
  owner: string,
  name: string,
): Promise<void> {
  return send("DELETE", componentPath(owner, name, "/favorite"));
}

/**
 * GET /v1/components/favorites — the session user's favorited components as
 * published metadata with counts, newest favorite first. Vanished components
 * are skipped server-side; every row carries favorited: true.
 */
export async function listFavoriteComponents(
  signal?: AbortSignal,
): Promise<CommunityComponent[]> {
  const body = await request<{ components?: unknown[] } | unknown[]>(
    "/v1/components/favorites",
    { signal },
  );
  const items = Array.isArray(body) ? body : (body.components ?? []);
  return items.map(toCommunityComponent);
}

/**
 * GET /v1/components/{owner}/{name}/versions/{n} — one immutable published
 * definition (public). Accepts the definition bare or under {definition}.
 */
export async function getComponentVersion(
  owner: string,
  name: string,
  version: number,
  signal?: AbortSignal,
): Promise<ComponentDefinition> {
  const body = await request<unknown>(
    componentPath(owner, name, `/versions/${version}`),
    { signal },
  );
  if (isComponentDefinition(body)) return body;
  const wrapped = (body as { definition?: unknown } | null)?.definition;
  if (isComponentDefinition(wrapped)) return wrapped;
  throw new ApiError(
    "invalid_response",
    `GET ${componentPath(owner, name, `/versions/${version}`)} returned no component definition`,
    200,
  );
}

// ---- fonts (font-system contract; §5 rendering) -------------------------

/** One built-in family (embedded server-side, usable by everyone). */
export interface BuiltinFontInfo {
  family: string;
  weights: number[];
}

/**
 * One uploaded font file owned by the session user (§7-style ownership:
 * usable only in the owner's designs; community components are rejected at
 * publish if they reference it). weight is 400 or 700; format is the
 * server-sniffed ttf/otf/woff.
 */
export interface UserFont {
  id: string;
  family: string;
  weight: number;
  format: string;
  size: number;
}

/** GET /v1/fonts body: built-ins for the picker + the session's uploads. */
export interface FontList {
  builtin: BuiltinFontInfo[];
  mine: UserFont[];
}

export async function listFonts(signal?: AbortSignal): Promise<FontList> {
  const body = await request<Partial<FontList> | null>("/v1/fonts", { signal });
  return {
    builtin: Array.isArray(body?.builtin) ? body.builtin : [],
    mine: Array.isArray(body?.mine) ? body.mine : [],
  };
}

/**
 * POST /v1/fonts (multipart: file + family + optional weight). The server
 * enforces what the upload dialog pre-checks (5MB, 10 fonts/user, magic-byte
 * TTF/OTF/WOFF validation — WOFF2 is a 400 explaining the satori
 * limitation); its error envelope surfaces inline via ApiError. No explicit
 * Content-Type: fetch derives the multipart boundary from the FormData.
 */
export function uploadFont(
  file: File,
  family: string,
  weight?: number,
): Promise<UserFont> {
  const form = new FormData();
  form.append("file", file);
  form.append("family", family);
  if (weight !== undefined) form.append("weight", String(weight));
  return request("/v1/fonts", { method: "POST", body: form });
}

/**
 * DELETE /v1/fonts/{id} — designs referencing the family keep rendering,
 * falling back to Inter with a render warning (never a failure).
 */
export function deleteFont(id: string): Promise<void> {
  return send("DELETE", `/v1/fonts/${encodeURIComponent(id)}`);
}

/**
 * GET /v1/fonts/{id}/file (owner-only) — the canvas's FontFace source
 * (lib/fontFaces.ts). A URL, not a fetch helper: the caller streams the
 * binary itself.
 */
export function fontFileUrl(id: string): string {
  return `/v1/fonts/${encodeURIComponent(id)}/file`;
}

// ---- deploy tokens (architecture §8) ------------------------------------

export async function listDeployTokens(
  projectId: string,
  signal?: AbortSignal,
): Promise<DeployTokenInfo[]> {
  const body = await request<{ tokens?: DeployTokenInfo[] } | DeployTokenInfo[]>(
    `/v1/projects/${encodeURIComponent(projectId)}/tokens`,
    { signal },
  );
  return Array.isArray(body) ? body : (body.tokens ?? []);
}

export function createDeployToken(projectId: string): Promise<CreatedDeployToken> {
  return send("POST", `/v1/projects/${encodeURIComponent(projectId)}/tokens`);
}

export function revokeDeployToken(
  projectId: string,
  tokenId: string,
): Promise<void> {
  return send(
    "DELETE",
    `/v1/projects/${encodeURIComponent(projectId)}/tokens/${encodeURIComponent(tokenId)}`,
  );
}
