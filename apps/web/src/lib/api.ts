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
 */
export interface ConnectorField {
  path: string;
  description?: string;
  type: "string" | "number";
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
}

/** One community browse hit (GET /v1/community/components). */
export interface CommunityComponent {
  id: string;
  owner: string;
  title: string;
  description?: string;
  latestVersion: number;
  updatedAt?: string;
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
    latestVersion:
      typeof raw.latestVersion === "number"
        ? raw.latestVersion
        : typeof raw.version === "number"
          ? raw.version
          : 0,
    unlisted: raw.unlisted === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
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

/** GET /v1/community/components?q= — published components, newest first (public). */
export async function listCommunity(
  q: string,
  signal?: AbortSignal,
): Promise<CommunityComponent[]> {
  const query = q.trim() === "" ? "" : `?q=${encodeURIComponent(q.trim())}`;
  const body = await request<{ components?: unknown[] } | unknown[]>(
    `/v1/community/components${query}`,
    { signal },
  );
  const items = Array.isArray(body) ? body : (body.components ?? []);
  return items.map((item) => {
    const record = toComponentRecord(item);
    const raw = (item ?? {}) as Record<string, unknown>;
    return {
      id: record.id,
      owner:
        typeof raw.owner === "string" ? raw.owner : record.id.split("/")[0] ?? "",
      title: record.title,
      description: record.description,
      latestVersion: record.latestVersion,
      updatedAt: record.updatedAt,
    };
  });
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
