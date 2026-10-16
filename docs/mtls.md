# Client certificates (mTLS) through a reverse proxy

Reach Talon from anywhere, while only devices holding your client
certificate can connect. It works the way Immich does it:

- **Your reverse proxy** (Caddy, nginx, Traefik, Cloudflare…) faces the
  internet and demands a client certificate. Without one, the connection is
  refused before it reaches Talon.
- **Talon itself doesn't change.** Once a device is through the proxy, it
  authenticates with the bridge token exactly as before. The certificate
  controls who can *connect*; the token still controls who's *allowed in*.
- **The companion app** imports the certificate (`.p12`/`.pfx`) and presents
  it on every connection. It can also keep your home-network address and use
  it whenever it answers, which skips the proxy at home.

```
phone ──TLS + client cert──▶ reverse proxy ──▶ Talon bridge :19880 ◀── devices at home
(.p12 imported in the app)   (rejects anyone      (bearer token,         (local address,
                              without the cert)    as always)             same token)
```

## 1. Make a CA and a certificate per device

```bash
# Once: a private CA for your devices (keep ca.key safe)
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Talon clients" -out ca.crt

# Per device
openssl ecparam -name prime256v1 -genkey -noout -out phone.key
openssl req -new -key phone.key -subj "/CN=phone" -out phone.csr
openssl x509 -req -in phone.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -sha256 -out phone.crt

# Bundle for the app; -legacy keeps it readable on Android
openssl pkcs12 -export -legacy -in phone.crt -inkey phone.key -out phone.p12
```

Give `ca.crt` to your proxy. Copy `phone.p12` to the phone. To lock a device
out, stop trusting its certificate at the proxy, or rotate the CA.

## 2. Configure the proxy

Point it at the bridge (`https://<talon-host>:19880`; the bridge's certificate
is self-signed, so skip upstream verification) and require client
certificates signed by `ca.crt`.

**Caddy**

```caddyfile
talon.example.com {
	tls {
		client_auth {
			mode require_and_verify
			trust_pool file /etc/caddy/ca.crt   # Caddy < 2.8: trusted_ca_cert_file
		}
	}
	reverse_proxy https://192.168.1.20:19880 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}
```

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name talon.example.com;
    ssl_certificate     /etc/letsencrypt/live/talon.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/talon.example.com/privkey.pem;

    ssl_client_certificate /etc/nginx/ca.crt;
    ssl_verify_client on;

    location / {
        proxy_pass https://192.168.1.20:19880;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_buffering off;       # the live event stream (SSE)
        proxy_read_timeout 1h;
    }
}
```

**Traefik**

```yaml
tls:
  options:
    talon-mtls:
      clientAuth:
        caFiles: [/certs/ca.crt]
        clientAuthType: RequireAndVerifyClientCert
http:
  routers:
    talon:
      rule: Host(`talon.example.com`)
      tls:
        options: talon-mtls
      service: talon
  services:
    talon:
      loadBalancer:
        serversTransport: talon-insecure
        servers:
          - url: https://192.168.1.20:19880
  serversTransports:
    talon-insecure:
      insecureSkipVerify: true
```

**Cloudflare Tunnel.** Cloudflare's edge terminates TLS, so it checks the
certificate:

1. Tunnel public hostname `talon.example.com` → `https://<talon-host>:19880`,
   with *No TLS Verify* on.
2. **SSL/TLS → Client Certificates**:
   - Create a certificate per device. Cloudflare signs it; bundle the
     downloaded certificate and key with the `openssl pkcs12` command above.
   - Under **Hosts**, add `talon.example.com`.
3. **Security → WAF → custom rule**, action *Block*:
   `(http.host eq "talon.example.com" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked))`

Don't also forward port 19880 on your router. The proxy is meant to be the
only way in from outside.

**Changing the proxy config.** Once devices depend on the proxy, a typo in
its config takes every one of them offline. Check the file before every
reload, and reload only if the check passes. This applies to people and to
agents (a Talon agent with shell access editing the Caddyfile included):

```bash
# Caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  && sudo systemctl reload caddy
# nginx
sudo nginx -t && sudo systemctl reload nginx
```

Keep a copy of the last working config so you can put it back. Use
`reload`, not `restart`: when a reload fails, Caddy and nginx keep serving
the old config, but a restart with a bad config leaves nothing listening.
Afterwards, check that `https://talon.example.com/health` still answers.

## 3. Set up the app

1. Choose **Remote** and enter the website address:
   `https://talon.example.com`.
2. Enter the bridge **Token** as usual (`~/.talon/keys/bridge-token` on the
   Talon host).
3. Tap **Import certificate**, pick `phone.p12`, and enter its password.
4. Optionally, set **Local network address** to
   `https://192.168.1.20:19880`. The app uses it whenever it answers and the
   website address otherwise, and re-checks when your network changes.

Without the certificate, the app says the server requires one instead of
retrying forever.
