package main

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// Running behind a TLS-terminating reverse proxy (Nginx Proxy Manager, Caddy,
// a plain nginx) is the expected way to put this on HTTPS. The proxy tells us
// the browser's address in X-Forwarded-For and that the browser used HTTPS in
// X-Forwarded-Proto - but anyone can send those headers, so they are only
// believed from an address named with -trusted-proxy. By default that is
// this machine alone, which covers a proxy running beside the server.

var trustedProxies = mustParseProxies("127.0.0.0/8,::1/128")

// parseProxies reads a comma-separated list of addresses and CIDR ranges.
func parseProxies(list string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("%q is not an IP address or CIDR range", part)
			}
			bits := 128
			if ip.To4() != nil {
				ip, bits = ip.To4(), 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("%q is not an IP address or CIDR range", part)
		}
		out = append(out, n)
	}
	return out, nil
}

func mustParseProxies(list string) []*net.IPNet {
	n, err := parseProxies(list)
	if err != nil {
		panic(err)
	}
	return n
}

func isTrustedProxy(addr string) bool {
	ip := net.ParseIP(strings.TrimSpace(addr))
	if ip == nil {
		return false
	}
	for _, n := range trustedProxies {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// fromTrustedProxy reports whether the connection itself came from a proxy
// whose forwarding headers we believe.
func fromTrustedProxy(r *http.Request) bool {
	return isTrustedProxy(remoteHost(r))
}

// clientIP is the browser's address, for rate limiting. Each proxy appends
// the address it heard from to X-Forwarded-For, so the list is read from the
// right, past our own proxies; the entries further left were written by the
// client and prove nothing.
func clientIP(r *http.Request) string {
	host := remoteHost(r)
	fwd := r.Header.Get("X-Forwarded-For")
	if fwd == "" || !isTrustedProxy(host) {
		return host
	}
	hops := strings.Split(fwd, ",")
	for i := len(hops) - 1; i >= 0; i-- {
		hop := strings.TrimSpace(hops[i])
		if net.ParseIP(hop) == nil {
			break
		}
		if !isTrustedProxy(hop) || i == 0 {
			return hop
		}
	}
	return host
}

// requestIsHTTPS reports whether the browser's leg of the connection is TLS:
// served directly with -tls-cert, or by a trusted proxy that says so.
func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return fromTrustedProxy(r) && strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}
