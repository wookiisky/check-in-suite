package httpapi

import (
	"net/http"
	"net/netip"
)

// requestHTTPS trusts TLS directly and proxy protocol headers only from loopback peers.
func requestHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	return err == nil && peer.Addr().Unmap().IsLoopback() && r.Header.Get("X-Forwarded-Proto") == "https"
}
