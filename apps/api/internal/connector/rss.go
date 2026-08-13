package connector

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

// RSSConfig is the account config of the rss (blog) connector (auth tier
// none — the feed is public; the config is just WHICH feed to read).
type RSSConfig struct {
	FeedURL string `json:"feedUrl"`
}

// Validate implements AccountConfig. https-only and absolute is required
// here for early UX feedback, but this is NOT the SSRF boundary: the host
// could be re-pointed at a private address after configuration (DNS), so the
// fetch path re-validates every connection post-resolution (see the SSRF
// guard below).
func (c *RSSConfig) Validate() error {
	u, err := url.Parse(c.FeedURL)
	if err != nil || !u.IsAbs() || u.Scheme != "https" || u.Host == "" {
		return errors.New("feedUrl must be an absolute https URL")
	}
	return nil
}

// LookupFeedHostIPs resolves a feed host for the connect-time pre-check
// (ValidateConnect). A package variable so tests — including httpapi's
// account-route tests — can stub DNS.
var LookupFeedHostIPs = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, len(addrs))
	for i, a := range addrs {
		ips[i] = a.IP
	}
	return ips, nil
}

// connectLookupTimeout bounds the connect-time DNS lookup so a slow resolver
// cannot hang the account route.
const connectLookupTimeout = 5 * time.Second

// ValidateConnect implements ConnectValidator: a feedUrl whose host is (or
// currently resolves to) a blocked address is refused at connect time, so it
// is never stored and the user hears about it immediately instead of via a
// silently empty card. This is early UX on top of the SSRF boundary, not the
// boundary itself — DNS can be re-pointed after configuration, so the
// dial-time Control hook (below) remains the guard that matters. For the
// same reason a lookup FAILURE here is not fatal: the fetch path re-validates
// every connection post-resolution.
func (c *RSSConfig) ValidateConnect(ctx context.Context) error {
	if err := c.Validate(); err != nil {
		return err
	}
	u, err := url.Parse(c.FeedURL)
	if err != nil {
		return errors.New("feedUrl must be an absolute https URL")
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		if blockedFeedIP(ip) {
			return errors.New("feedUrl must not point at a private or internal address")
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, connectLookupTimeout)
	defer cancel()
	ips, err := LookupFeedHostIPs(ctx, host)
	if err != nil {
		return nil // resolution hiccup: allow; the fetch-time guard re-validates
	}
	for _, ip := range ips {
		if blockedFeedIP(ip) {
			return errors.New("feedUrl host resolves to a private or internal address")
		}
	}
	return nil
}

// RSSFields is the single source of truth for the rss snapshot shape. Keep
// it in sync with buildFeedSnapshot below.
var RSSFields = []Field{
	{Path: "feed.title", Description: "Feed title", Type: "string"},
	{Path: "posts", Description: "Latest 5 posts as [{title, date}]", Type: "series"},
}

// feedPostLimit is how many posts the snapshot keeps.
const feedPostLimit = 5

// ---- SSRF guard -----------------------------------------------------------
// SECURITY BOUNDARY (architecture.md §9): feedUrl is user-controlled, so this
// connector makes server-side requests to arbitrary hosts. Without these
// checks a user could point their "feed" at internal services (cloud metadata
// endpoints, localhost admin ports, private-network hosts) and exfiltrate the
// response through their card or through error messages. Guards:
//
//   - https only, checked on the initial URL and re-checked on EVERY redirect
//     hop (max 3) via CheckRedirect;
//   - every connection — the initial request and each redirect hop — has its
//     RESOLVED IP validated in the dialer's Control hook. Post-resolution is
//     the point that matters: validating the hostname before the request
//     would be defeated by DNS rebinding;
//   - blocked ranges: loopback (127.0.0.0/8, ::1), private (10.0.0.0/8,
//     172.16.0.0/12, 192.168.0.0/16), link-local incl. cloud metadata
//     (169.254.0.0/16, fe80::/10), ULA (fc00::/7), unspecified and multicast;
//   - proxies are disabled for feed fetches — a proxy would dial the proxy,
//     not the target, and the Control hook must see the real destination;
//   - 2 MB response cap (io.LimitReader) and a 10 s total timeout.
//
// Additionally, ValidateConnect (above) refuses blocked hosts already at
// configuration time so they are never stored — early UX, not the boundary.

const (
	feedTimeout      = 10 * time.Second
	feedMaxBytes     = 2 << 20 // 2 MB response cap
	feedMaxRedirects = 3
)

var errPrivateFeedHost = errors.New("connector: rss: feed host resolves to a private or internal address")

// blockedFeedIP reports whether a resolved feed address falls in a range the
// SSRF guard rejects (see the boundary comment above for the range list).
func blockedFeedIP(ip net.IP) bool {
	return ip == nil ||
		ip.IsLoopback() || // 127.0.0.0/8, ::1
		ip.IsPrivate() || // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7 (ULA)
		ip.IsLinkLocalUnicast() || // 169.254.0.0/16 (metadata), fe80::/10
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() // 0.0.0.0, ::
}

// feedDialControl is the net.Dialer Control hook: it runs after DNS
// resolution for every connection attempt (including each redirect hop's new
// connection), with address always in ip:port form.
func feedDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("connector: rss: malformed dial address %q: %w", address, err)
	}
	if blockedFeedIP(net.ParseIP(host)) {
		return errPrivateFeedHost
	}
	return nil
}

// checkFeedRedirect enforces the redirect budget and re-validates the scheme
// per hop; the Control hook independently re-validates each hop's resolved
// address when the new connection is dialed.
func checkFeedRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= feedMaxRedirects {
		return fmt.Errorf("connector: rss: more than %d redirects", feedMaxRedirects)
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("connector: rss: redirect to non-https URL %q refused", req.URL.Redacted())
	}
	return nil
}

// newFeedClient builds the SSRF-guarded HTTP client the connector fetches
// feeds with.
func newFeedClient() *http.Client {
	dialer := &net.Dialer{Timeout: feedTimeout, Control: feedDialControl}
	return &http.Client{
		Timeout: feedTimeout,
		Transport: &http.Transport{
			Proxy:       nil, // never via a proxy: the Control hook must see the real target
			DialContext: dialer.DialContext,
		},
		CheckRedirect: checkFeedRedirect,
	}
}

// ---- connector -------------------------------------------------------------

// RSS is the blog-feed connector: it fetches the configured RSS 2.0 or Atom
// feed and snapshots the feed title plus the latest posts. Without config it
// serves the dev fixture (dev) or an empty snapshot (production).
type RSS struct {
	fixture map[string]any
	sealer  crypto.Sealer
	client  *http.Client // SSRF-guarded; tests may swap it for the happy path
}

// RSSDeps wires the live half of the connector. There is no base URL — the
// feed URL itself is the per-user config.
type RSSDeps struct {
	Sealer crypto.Sealer
}

// NewRSS loads the optional fixture fallback (dev only; empty path means
// none) and wires the guarded feed client.
func NewRSS(fixturePath string, deps RSSDeps) (*RSS, error) {
	fix, err := loadFixture(fixturePath, "blog")
	if err != nil {
		return nil, err
	}
	return &RSS{
		fixture: fix,
		sealer:  deps.Sealer,
		client:  newFeedClient(),
	}, nil
}

// Name implements Connector.
func (r *RSS) Name() string { return "rss" }

// SnapshotTTL implements Connector (manifest value).
func (r *RSS) SnapshotTTL() time.Duration { return time.Hour }

// Fetch implements Connector. Feed failures (unreachable host, non-XML body,
// SSRF-refused address) are ordinary errors the SnapshotCache absorbs by
// serving the last good snapshot stale.
func (r *RSS) Fetch(ctx context.Context, account *store.ConnectorAccount) (map[string]any, error) {
	if account == nil || len(account.EncryptedCredentials) == 0 {
		if r.fixture != nil {
			return r.fixture, nil
		}
		return map[string]any{}, nil // production unconfigured: em-dash semantics
	}
	var cfg RSSConfig
	if err := openAccountConfig(r.sealer, "rss", account, &cfg); err != nil {
		return nil, err
	}
	// Re-validate at fetch time: stored config could predate a validation
	// change, and the scheme check must hold on the very first request (the
	// redirect hook only sees hops).
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("connector: rss: stored config invalid: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.FeedURL, nil)
	if err != nil {
		return nil, fmt.Errorf("connector: rss: building request: %w", err)
	}
	req.Header.Set("User-Agent", "makeitbeauty-connector")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connector: rss: fetching feed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("connector: rss: feed responded %d", resp.StatusCode)
	}

	// Content-Type is deliberately not enforced (feeds lie about it); a body
	// that fails XML parsing is a normal error. The LimitReader caps memory:
	// an over-cap feed truncates and fails the parse.
	return parseFeed(io.LimitReader(resp.Body, feedMaxBytes))
}

// feedDoc captures both feed dialects in one shape: RSS 2.0 nests everything
// under <channel>, Atom puts <title> and <entry> directly under <feed> — the
// two field sets can never both match, and XMLName tells them apart.
type feedDoc struct {
	XMLName xml.Name
	Channel *struct {
		Title string `xml:"title"`
		Items []struct {
			Title   string `xml:"title"`
			PubDate string `xml:"pubDate"`
		} `xml:"item"`
	} `xml:"channel"`
	Title   string `xml:"title"`
	Entries []struct {
		Title     string `xml:"title"`
		Published string `xml:"published"`
		Updated   string `xml:"updated"`
	} `xml:"entry"`
}

// feedPost is one normalized post prior to snapshot encoding.
type feedPost struct {
	Title string
	Date  string // YYYY-MM-DD, "" when the feed's date is unparseable
}

// parseFeed decodes an RSS 2.0 or Atom document and builds the snapshot.
func parseFeed(body io.Reader) (map[string]any, error) {
	var doc feedDoc
	if err := xml.NewDecoder(body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("connector: rss: feed is not valid XML: %w", err)
	}

	var title string
	var posts []feedPost
	switch {
	case doc.XMLName.Local == "rss" && doc.Channel != nil:
		title = doc.Channel.Title
		for _, item := range doc.Channel.Items {
			posts = append(posts, feedPost{Title: strings.TrimSpace(item.Title), Date: feedDate(item.PubDate)})
		}
	case doc.XMLName.Local == "feed":
		title = doc.Title
		for _, entry := range doc.Entries {
			date := entry.Published
			if date == "" {
				date = entry.Updated
			}
			posts = append(posts, feedPost{Title: strings.TrimSpace(entry.Title), Date: feedDate(date)})
		}
	default:
		return nil, fmt.Errorf("connector: rss: root element <%s> is neither RSS 2.0 nor Atom", doc.XMLName.Local)
	}
	if len(posts) > feedPostLimit {
		posts = posts[:feedPostLimit]
	}
	return buildFeedSnapshot(title, posts), nil
}

// feedDateLayouts are the timestamp formats seen in the wild: RFC 822/1123
// variants (RSS pubDate, with and without zero-padded days) and RFC 3339
// (Atom).
var feedDateLayouts = []string{
	time.RFC1123Z,
	time.RFC1123,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon, 2 Jan 2006 15:04:05 MST",
	time.RFC822Z,
	time.RFC822,
	time.RFC3339,
	"2006-01-02",
}

// feedDate normalizes a feed timestamp to YYYY-MM-DD; unparseable input
// yields "" (the renderer's missing-value semantics handle it).
func feedDate(raw string) string {
	raw = strings.TrimSpace(raw)
	for _, layout := range feedDateLayouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return ""
}

// buildFeedSnapshot maps the parsed feed onto the RSSFields paths.
func buildFeedSnapshot(title string, posts []feedPost) map[string]any {
	series := make([]any, len(posts))
	for i, p := range posts {
		series[i] = map[string]any{"title": p.Title, "date": p.Date}
	}
	return map[string]any{
		"feed":  map[string]any{"title": strings.TrimSpace(title)},
		"posts": series,
	}
}
