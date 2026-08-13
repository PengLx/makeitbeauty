/** External links used across the landing page sections. */
export const REPO_URL = "https://github.com/PengLx/makeitbeauty";
export const ARCHITECTURE_URL = `${REPO_URL}/blob/main/docs/architecture.md`;
export const SECURITY_URL = `${REPO_URL}/blob/main/docs/SECURITY.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

/**
 * Sign-in entry point. Must stay a plain anchor — /v1/auth/github/login is a
 * full navigation (302 to GitHub) through the /v1 proxy, not a fetch.
 */
export const SIGN_IN_URL = "/v1/auth/github/login";
