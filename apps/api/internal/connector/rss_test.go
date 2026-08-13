package connector

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/crypto"
	"github.com/makeitbeauty/makeitbeauty/apps/api/internal/store"
)

const testRSSFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Grace's Blog</title>
    <item><title>Post one</title><pubDate>Fri, 01 Aug 2025 10:30:00 +0000</pubDate></item>
    <item><title>Post two</title><pubDate>Sat, 2 Aug 2025 09:00:00 GMT</pubDate></item>
    <item><title>  Post three  </title><pubDate>garbage date</pubDate></item>
    <item><title>Post four</title><pubDate>Mon, 04 Aug 2025 08:00:00 +0200</pubDate></item>
    <item><title>Post five</title><pubDate>Tue, 05 Aug 2025 08:00:00 +0000</pubDate></item>
    <item><title>Post six</title><pubDate>Wed, 06 Aug 2025 08:00:00 +0000</pubDate></item>
    <item><title>Post seven</title><pubDate>Thu, 07 Aug 2025 08:00:00 +0000</pubDate></item>
  </channel>
</rss>`

const testAtomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Grace's Atom Feed</title>
  <entry><title>Entry one</title><published>2025-08-01T10:30:00Z</published></entry>
  <entry><title>Entry two</title><updated>2025-07-20T08:00:00+02:00</updated></entry>
</feed>`

// newTestRSS wires an RSS connector with no fixture plus a sealed account
// pointing at feedURL.
func newTestRSS(t *testing.T, feedURL string) (*RSS, *store.ConnectorAccount) {
	t.Helper()
	r, err := NewRSS("", RSSDeps{Sealer: crypto.PlainSealer{}})
	if err != nil {
		t.Fatal(err)
	}
	return r, sealConfigAccount(t, "rss", RSSConfig{FeedURL: feedURL})
}

// testFeedClient returns a client that trusts srv's TLS certificate and may
// dial srv's own address directly, while every OTHER address still runs the
// REAL SSRF dial guard — so redirect hops to private ranges stay blocked —
// and redirect policy is the real production checkFeedRedirect.
func testFeedClient(t *testing.T, srv *httptest.Server) *http.Client {
	t.Helper()
	base, ok := srv.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatalf("test server transport is %T, want *http.Transport", srv.Client().Transport)
	}
	tr := base.Clone()
	srvAddr := srv.Listener.Addr().String()
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != srvAddr {
			if err := feedDialControl(network, addr, nil); err != nil {
				return nil, err
			}
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return &http.Client{Transport: tr, CheckRedirect: checkFeedRedirect, Timeout: feedTimeout}
}

func TestRSSFetchWithoutConfigServesFixture(t *testing.T) {
	r, err := NewRSS(testFixturePath, RSSDeps{})
	if err != nil {
		t.Fatal(err)
	}
	for name, account := range map[string]*store.ConnectorAccount{
		"nil account":            nil,
		"account without config": {ID: "acct-x", UserID: "dev", Connector: "rss", Status: "active"},
	} {
		t.Run(name, func(t *testing.T) {
			snap, err := r.Fetch(context.Background(), account)
			if err != nil {
				t.Fatal(err)
			}
			if got := lookupPath(t, snap, "feed", "title"); got != "Ada's Notebook" {
				t.Errorf("feed.title = %v, want the fixture value", got)
			}
			posts, ok := lookupPath(t, snap, "posts").([]any)
			if !ok || len(posts) != 5 {
				t.Errorf("posts has %d entries, want 5", len(posts))
			}
			assertCatalogResolves(t, RSSFields, snap)
		})
	}
}

func TestRSSFetchUnconfiguredWithoutFixtureIsEmpty(t *testing.T) {
	r, err := NewRSS("", RSSDeps{})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := r.Fetch(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap) != 0 {
		t.Errorf("snapshot = %#v, want empty non-nil map", snap)
	}
}

func TestRSSFetchRSS2(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Deliberately lying content type: feeds do, and it is not enforced.
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(testRSSFeed))
	}))
	t.Cleanup(srv.Close)

	r, account := newTestRSS(t, srv.URL+"/feed.xml")
	r.client = testFeedClient(t, srv)

	snap, err := r.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupPath(t, snap, "feed", "title"); got != "Grace's Blog" {
		t.Errorf("feed.title = %v", got)
	}
	want := []any{
		map[string]any{"title": "Post one", "date": "2025-08-01"},
		map[string]any{"title": "Post two", "date": "2025-08-02"},
		map[string]any{"title": "Post three", "date": ""}, // unparseable date, trimmed title
		map[string]any{"title": "Post four", "date": "2025-08-04"},
		map[string]any{"title": "Post five", "date": "2025-08-05"},
	}
	if got := lookupPath(t, snap, "posts"); !reflect.DeepEqual(got, want) {
		t.Errorf("posts = %#v, want %#v (top 5 of 7)", got, want)
	}
	assertCatalogResolves(t, RSSFields, snap)
}

func TestRSSFetchAtom(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(testAtomFeed))
	}))
	t.Cleanup(srv.Close)

	r, account := newTestRSS(t, srv.URL+"/atom.xml")
	r.client = testFeedClient(t, srv)

	snap, err := r.Fetch(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	if got := lookupPath(t, snap, "feed", "title"); got != "Grace's Atom Feed" {
		t.Errorf("feed.title = %v", got)
	}
	want := []any{
		map[string]any{"title": "Entry one", "date": "2025-08-01"},
		map[string]any{"title": "Entry two", "date": "2025-07-20"}, // updated fallback
	}
	if got := lookupPath(t, snap, "posts"); !reflect.DeepEqual(got, want) {
		t.Errorf("posts = %#v, want %#v", got, want)
	}
}

func TestRSSFetchMalformedPayloads(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{"not XML", http.StatusOK, "certainly not a feed"},
		{"XML but neither dialect", http.StatusOK, "<html><body>login page</body></html>"},
		{"http 404", http.StatusNotFound, "not here"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			t.Cleanup(srv.Close)
			r, account := newTestRSS(t, srv.URL+"/feed")
			r.client = testFeedClient(t, srv)
			if _, err := r.Fetch(context.Background(), account); err == nil {
				t.Fatal("Fetch succeeded on a malformed feed")
			}
		})
	}
}

// A feed larger than the 2 MB cap truncates at the LimitReader and fails the
// XML parse — the cap can never be silently exceeded.
func TestRSSFetchResponseCap(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<?xml version="1.0"?><rss version="2.0"><channel><title>big</title>`))
		filler := strings.Repeat("<item><title>"+strings.Repeat("x", 1000)+"</title></item>", 3000) // ~3 MB
		_, _ = w.Write([]byte(filler))
		_, _ = w.Write([]byte(`</channel></rss>`))
	}))
	t.Cleanup(srv.Close)

	r, account := newTestRSS(t, srv.URL+"/feed")
	r.client = testFeedClient(t, srv)
	if _, err := r.Fetch(context.Background(), account); err == nil {
		t.Fatal("Fetch succeeded on an over-cap feed")
	}
}

// ---- SSRF guard ------------------------------------------------------------

func TestBlockedFeedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.8.8.8", // loopback
		"10.0.0.1", "10.255.255.255", // 10/8
		"172.16.0.1", "172.31.255.255", // 172.16/12
		"192.168.0.1", "192.168.255.1", // 192.168/16
		"169.254.169.254", "169.254.0.1", // link-local / metadata
		"::1",                // v6 loopback
		"fe80::1",            // v6 link-local
		"fc00::1", "fdff::1", // ULA fc00::/7
		"0.0.0.0", "::", // unspecified
		"224.0.0.1", // multicast
	}
	for _, s := range blocked {
		if !blockedFeedIP(net.ParseIP(s)) {
			t.Errorf("blockedFeedIP(%s) = false, want true", s)
		}
	}
	allowed := []string{
		"8.8.8.8", "1.1.1.1", "93.184.216.34",
		"11.0.0.1",             // just past 10/8
		"172.15.0.1",           // below 172.16/12
		"172.32.0.1",           // above 172.16/12
		"192.169.0.1",          // past 192.168/16
		"169.255.0.1",          // past 169.254/16
		"2606:4700:4700::1111", // public v6
	}
	for _, s := range allowed {
		if blockedFeedIP(net.ParseIP(s)) {
			t.Errorf("blockedFeedIP(%s) = true, want false", s)
		}
	}
	if !blockedFeedIP(nil) {
		t.Error("blockedFeedIP(nil) = false, want true (unparseable addresses are refused)")
	}
}

// The full guard, end to end through Fetch with the REAL client: every
// blocked range, the plain-http scheme, and a hostname that resolves to a
// private address must all refuse before any request is made.
func TestRSSFetchSSRFBlocked(t *testing.T) {
	urls := []string{
		"http://feeds.example.com/rss.xml", // scheme: https only
		"https://127.0.0.1/feed",
		"https://10.0.0.8/feed",
		"https://172.16.4.2/feed",
		"https://192.168.1.20/feed",
		"https://169.254.169.254/latest/meta-data/", // cloud metadata
		"https://[::1]/feed",
		"https://[fe80::1]/feed",
		"https://[fd12:3456::1]/feed", // ULA
		"https://0.0.0.0/feed",
		"https://localhost/feed", // host RESOLVING to loopback (post-resolve check)
	}
	for _, feedURL := range urls {
		t.Run(feedURL, func(t *testing.T) {
			// Sealed directly, bypassing PUT validation: the fetch-time guard
			// must hold even for stored config that predates validation.
			r, account := newTestRSS(t, feedURL)
			_, err := r.Fetch(context.Background(), account)
			if err == nil {
				t.Fatal("Fetch succeeded against a blocked target")
			}
		})
	}
}

// A public-looking feed that redirects to a private address is blocked at
// the redirect hop's dial — the guard runs per connection, not per config.
func TestRSSFetchRedirectToPrivateBlocked(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://10.0.0.9/feed", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	r, account := newTestRSS(t, srv.URL+"/feed")
	r.client = testFeedClient(t, srv) // guard active for every non-srv address
	_, err := r.Fetch(context.Background(), account)
	if err == nil {
		t.Fatal("Fetch followed a redirect to a private address")
	}
	if !errors.Is(err, errPrivateFeedHost) {
		t.Errorf("err = %v, want errPrivateFeedHost", err)
	}
}

func TestRSSFetchRedirectToHTTPBlocked(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://feeds.example.com/rss.xml", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	r, account := newTestRSS(t, srv.URL+"/feed")
	r.client = testFeedClient(t, srv)
	_, err := r.Fetch(context.Background(), account)
	if err == nil || !strings.Contains(err.Error(), "non-https") {
		t.Fatalf("err = %v, want a non-https redirect refusal", err)
	}
}

func TestRSSFetchRedirectBudget(t *testing.T) {
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/hop/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+r.URL.Path+"x", http.StatusFound) // endless chain
	})
	mux.HandleFunc("/two", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+"/one", http.StatusFound)
	})
	mux.HandleFunc("/one", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+"/feed", http.StatusFound)
	})
	mux.HandleFunc("/feed", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(testAtomFeed))
	})
	srv = httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)

	// Two hops to the feed: fine.
	r, account := newTestRSS(t, srv.URL+"/two")
	r.client = testFeedClient(t, srv)
	if _, err := r.Fetch(context.Background(), account); err != nil {
		t.Fatalf("two redirects should be allowed: %v", err)
	}

	// An endless chain trips the max-3 budget.
	r, account = newTestRSS(t, srv.URL+"/hop/a")
	r.client = testFeedClient(t, srv)
	if _, err := r.Fetch(context.Background(), account); err == nil || !strings.Contains(err.Error(), "redirects") {
		t.Fatalf("err = %v, want the redirect budget refusal", err)
	}
}

func TestRSSConfigValidate(t *testing.T) {
	if err := (&RSSConfig{FeedURL: "https://blog.example.com/rss.xml"}).Validate(); err != nil {
		t.Errorf("valid feedUrl rejected: %v", err)
	}
	for _, bad := range []string{
		"",
		"http://blog.example.com/rss.xml", // https only
		"ftp://blog.example.com/rss.xml",
		"/relative/feed.xml",
		"blog.example.com/rss.xml",
		"https://", // no host
	} {
		if err := (&RSSConfig{FeedURL: bad}).Validate(); err == nil {
			t.Errorf("feedUrl %q accepted", bad)
		}
	}
}

// stubFeedLookup swaps the connect-time DNS hook for the test's lifetime.
func stubFeedLookup(t *testing.T, fn func(ctx context.Context, host string) ([]net.IP, error)) {
	t.Helper()
	prev := LookupFeedHostIPs
	LookupFeedHostIPs = fn
	t.Cleanup(func() { LookupFeedHostIPs = prev })
}

// ValidateConnect refuses blocked hosts at configuration time: IP literals
// directly, hostnames via their (stubbed) resolution. A lookup failure is
// fail-open — the dial-time Control hook stays the SSRF boundary.
func TestRSSConfigValidateConnect(t *testing.T) {
	ctx := context.Background()

	// IP literals: no DNS involved at all.
	stubFeedLookup(t, func(context.Context, string) ([]net.IP, error) {
		t.Fatal("IP-literal hosts must not be resolved")
		return nil, nil
	})
	for _, blocked := range []string{
		"https://127.0.0.1/feed.xml",
		"https://127.8.9.10/feed.xml",
		"https://[::1]/feed.xml",
		"https://169.254.169.254/latest/meta-data/",
		"https://192.168.1.1/feed.xml",
		"https://10.0.0.7/feed.xml",
		"https://172.16.4.4/feed.xml",
		"https://[fd00::5]/feed.xml",
		"https://0.0.0.0/feed.xml",
	} {
		if err := (&RSSConfig{FeedURL: blocked}).ValidateConnect(ctx); err == nil {
			t.Errorf("ValidateConnect accepted blocked IP literal %q", blocked)
		}
	}
	if err := (&RSSConfig{FeedURL: "https://93.184.216.34/feed.xml"}).ValidateConnect(ctx); err != nil {
		t.Errorf("ValidateConnect rejected public IP literal: %v", err)
	}

	// Scheme/shape failures surface exactly like Validate.
	if err := (&RSSConfig{FeedURL: "http://blog.example.com/rss.xml"}).ValidateConnect(ctx); err == nil {
		t.Error("ValidateConnect accepted an http URL")
	}

	// Hostname resolving to loopback (the localtest.me shape): refused.
	stubFeedLookup(t, func(_ context.Context, host string) ([]net.IP, error) {
		if host != "localtest.me" {
			t.Errorf("resolved host = %q, want localtest.me", host)
		}
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	})
	if err := (&RSSConfig{FeedURL: "https://localtest.me/feed.xml"}).ValidateConnect(ctx); err == nil {
		t.Error("ValidateConnect accepted a hostname resolving to loopback")
	}

	// Mixed resolution (one public, one private — rebinding shape): refused.
	stubFeedLookup(t, func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("10.0.0.9")}, nil
	})
	if err := (&RSSConfig{FeedURL: "https://mixed.example.com/feed.xml"}).ValidateConnect(ctx); err == nil {
		t.Error("ValidateConnect accepted a host with a private address in its answer set")
	}

	// Public resolution: accepted.
	stubFeedLookup(t, func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("203.0.113.9")}, nil
	})
	if err := (&RSSConfig{FeedURL: "https://blog.example.com/rss.xml"}).ValidateConnect(ctx); err != nil {
		t.Errorf("ValidateConnect rejected a public host: %v", err)
	}

	// Lookup failure: fail-open (the fetch-time guard re-validates).
	stubFeedLookup(t, func(context.Context, string) ([]net.IP, error) {
		return nil, errors.New("NXDOMAIN")
	})
	if err := (&RSSConfig{FeedURL: "https://unresolvable.example.com/rss.xml"}).ValidateConnect(ctx); err != nil {
		t.Errorf("ValidateConnect rejected on lookup failure: %v", err)
	}
}

func TestRSSFieldsCatalogTypes(t *testing.T) {
	want := map[string]string{
		"feed.title": "string",
		"posts":      "series",
	}
	if len(RSSFields) != len(want) {
		t.Fatalf("RSSFields has %d entries, want %d", len(RSSFields), len(want))
	}
	for _, f := range RSSFields {
		if want[f.Path] == "" {
			t.Errorf("unexpected field %q", f.Path)
		} else if f.Type != want[f.Path] {
			t.Errorf("field %q type = %q, want %q", f.Path, f.Type, want[f.Path])
		}
		if f.Description == "" {
			t.Errorf("field %q has no description", f.Path)
		}
	}
}
