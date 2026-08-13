export type SandboxErrorCode =
  | "compile_error"
  | "runtime_error"
  | "timeout"
  | "memory"
  | "not_a_function"
  | "async_result"
  | "output_too_large"
  | "output_invalid";

/** Hard cap on error message length exposed to callers. */
export const MAX_ERROR_MESSAGE_CHARS = 1024;

/**
 * Sanitize text that originated inside the sandbox (or was derived from it)
 * before it becomes a host-side error message: strip control characters
 * (except newline and tab, which stack traces legitimately use) and cap the
 * length. Authors need the sandbox-side error text to debug; hosts need it
 * to be inert and bounded.
 */
export function sanitizeErrorText(raw: string): string {
  let s = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ");
  if (s.length > MAX_ERROR_MESSAGE_CHARS) {
    s = s.slice(0, MAX_ERROR_MESSAGE_CHARS) + "… [truncated]";
  }
  return s;
}

/**
 * The single error type thrown by executeRender (and carried in
 * compileComponent's failure result). `code` is machine-readable; `message`
 * includes the sanitized, length-capped sandbox-side error text so component
 * authors can debug at publish time.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(sanitizeErrorText(message));
    this.name = "SandboxError";
    this.code = code;
  }
}
