import { describe, expect, it } from "vitest";
import {
  accountConfigSpec,
  feedHost,
  forgetAccountHint,
  recallAccountHint,
  rememberAccountHint,
} from "./connectorAccounts";

describe("accountConfigSpec", () => {
  it("serves specs for exactly the config-tier connectors", () => {
    expect(accountConfigSpec("wakatime")?.field).toBe("apiKey");
    expect(accountConfigSpec("leetcode")?.field).toBe("username");
    expect(accountConfigSpec("rss")?.field).toBe("feedUrl");
  });

  it("returns null for OAuth-tier and unknown connectors", () => {
    expect(accountConfigSpec("github")).toBeNull(); // login-provisioned
    expect(accountConfigSpec("spotify")).toBeNull();
    expect(accountConfigSpec("")).toBeNull();
  });
});

describe("wakatime spec", () => {
  const spec = accountConfigSpec("wakatime")!;

  it("rejects only an empty key (server owns real verification)", () => {
    expect(spec.validate("")).toMatch(/API key/);
    expect(spec.validate("waka_00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("never derives a display hint from the credential", () => {
    expect(spec.hintFromValue("waka_secret")).toBeNull();
  });

  it("summarizes with fixed masked text regardless of hint", () => {
    expect(spec.summary(null)).toBe("API key set");
    expect(spec.summary("anything")).toBe("API key set");
  });

  it("uses a password input so the key stays off-screen", () => {
    expect(spec.inputType).toBe("password");
  });
});

describe("leetcode spec", () => {
  const spec = accountConfigSpec("leetcode")!;

  it("mirrors the server's ^[A-Za-z0-9_-]{1,40}$ rule", () => {
    expect(spec.validate("liu2248")).toBeNull();
    expect(spec.validate("a")).toBeNull();
    expect(spec.validate("A-b_9")).toBeNull();
    expect(spec.validate("a".repeat(40))).toBeNull();

    expect(spec.validate("")).not.toBeNull();
    expect(spec.validate("a".repeat(41))).not.toBeNull();
    expect(spec.validate("has space")).not.toBeNull();
    expect(spec.validate("dot.ted")).not.toBeNull();
    expect(spec.validate("émile")).not.toBeNull();
  });

  it("remembers the username and shows it when connected", () => {
    expect(spec.hintFromValue("liu2248")).toBe("liu2248");
    expect(spec.summary("liu2248")).toBe("liu2248");
    expect(spec.summary(null)).toBe("Username set");
  });
});

describe("rss spec", () => {
  const spec = accountConfigSpec("rss")!;

  it("accepts only absolute https URLs (mirrors the server)", () => {
    expect(spec.validate("https://blog.example.com/feed.xml")).toBeNull();
    expect(spec.validate("https://example.com:8443/atom")).toBeNull();

    expect(spec.validate("")).not.toBeNull();
    expect(spec.validate("http://blog.example.com/feed.xml")).not.toBeNull();
    expect(spec.validate("/feed.xml")).not.toBeNull();
    expect(spec.validate("blog.example.com/feed.xml")).not.toBeNull();
    expect(spec.validate("ftp://example.com/feed")).not.toBeNull();
    expect(spec.validate("not a url")).not.toBeNull();
  });

  it("summarizes as the feed host, not the full URL", () => {
    expect(spec.hintFromValue("https://blog.example.com/feed.xml")).toBe(
      "blog.example.com",
    );
    expect(spec.summary("blog.example.com")).toBe("blog.example.com");
    expect(spec.summary(null)).toBe("Feed configured");
  });
});

describe("feedHost", () => {
  it("extracts host (with port) from absolute https URLs", () => {
    expect(feedHost("https://example.com/feed")).toBe("example.com");
    expect(feedHost("https://example.com:8443/feed")).toBe("example.com:8443");
  });

  it("returns null for non-https or unparsable input", () => {
    expect(feedHost("http://example.com/feed")).toBeNull();
    expect(feedHost("//example.com/feed")).toBeNull();
    expect(feedHost("feed.xml")).toBeNull();
    expect(feedHost("")).toBeNull();
  });
});

describe("account hints without localStorage (node env)", () => {
  it("degrades to null instead of throwing", () => {
    // These tests run in plain node — no localStorage exists. The helpers
    // must swallow that (private-mode browsers hit the same path).
    expect(() => rememberAccountHint("leetcode", "liu2248")).not.toThrow();
    expect(recallAccountHint("leetcode")).toBeNull();
    expect(() => forgetAccountHint("leetcode")).not.toThrow();
  });
});
