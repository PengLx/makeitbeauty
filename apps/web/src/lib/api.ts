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

/** One bindable snapshot field, e.g. {path: "github.followers", …}. */
export interface ConnectorField {
  path: string;
  description?: string;
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
