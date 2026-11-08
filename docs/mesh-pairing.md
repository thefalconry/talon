# Pairing a device with the mesh

A companion joins the mesh by being told three things: the bridge's address,
its bearer token, and — over TLS — the certificate fingerprint to pin. Reading
those off a terminal and typing them into a phone is the worst step in setting
Talon up, and a mistyped token fails in a way that looks like a network
problem.

`/mesh link` removes the typing.

The token a link carries is a **per-device credential** minted for the phone
that redeems it (device + chat UI scopes), not the daemon's shared token —
see [mesh-credentials.md](mesh-credentials.md).

## From Telegram

```
/mesh            fleet report, plus the bridge a new device would dial
/mesh link       mint a single-use pairing link  (admin only)
/mesh link Car   …and name the connection on the phone
```

`/mesh link` replies with a URL. Open it **on the phone**. The bridge serves a
page whose button is a `talon://pair` deep link carrying the credentials, so
the companion fills in its own connection form and connects.

Who sees what:

- **The admin** gets the whole connection profile in plain `/mesh` — URL,
  bearer token, certificate fingerprint — because an operator asking their own
  daemon how to reach itself should get an answer, not a scavenger hunt
  through config files. `/mesh link` is theirs too.
- **Everyone else** gets the address and whether a token is needed, and
  nothing more. A group member reading the fleet has no business holding the
  key to it.

The link is still the better way to move credentials onto a phone: it expires
in ten minutes and dies on first use, while a token pasted into a chat lives
as long as the chat does.

## What the link actually is

```
GET /pair?grant=<token>              → the pairing page
GET /pair?grant=<token>&format=json  → the same payload as JSON
```

The route is **pre-auth by design** — the phone holds no bridge credential
yet, which is the whole point — so the grant token is the entire
authorization, exactly like node provisioning ([headless-node.md](headless-node.md))
and streamed transfers: random 192-bit, single-use, expiring unused after ten
minutes. Serving the page *is* the handover, so the grant is spent whichever
leg is hit first; a replayed URL gets a 404.

The page carries the credentials in its button rather than making the app
redeem the grant itself:

```
talon://pair?u=<bridge url>&t=<token>&f=<fingerprint>&n=<label>
```

By the time the page renders, the grant is already spent — a deep link that
needed one more round trip would fail on exactly the flaky first connection it
exists to make painless.

The page is one self-contained file with no external assets. It is served by a
bridge the browser has usually just warned about (self-signed certificate),
often over a LAN with no internet route, and a page that half-loads there is
worse than no page at all. It also prints the raw values, because a deep link
is precisely the thing that silently does nothing when the app isn't installed
yet.

## On the phone

Tapping **Open in Talon** lands on `MainActivity`'s `talon://pair` intent
filter. The native side (`PairBridge`) *holds* the link until Dart asks for it:
a cold start delivers the intent long before Flutter is listening. It is handed
over exactly once — a link that reconfigured the connection on every rebuild
would fight whatever the user did next.

- **First run**: applied immediately. There is nothing to lose.
- **Already connected**: a confirmation first. Silently repointing a working
  app at a different daemon reads as a bug.

If the button does nothing — the app isn't installed, or the browser won't hand
over the scheme — long-press the link, copy it, and use **Paste a pairing
link** on the connect screen. Same payload, same result. On an embedded unit
where "tap the link" isn't always available, that path is the reliable one.

## When it can't mint

- *The native bridge isn't running* — enable the native frontend.
- *The bridge has no bearer token* — it is bound to loopback only, which no
  other device can reach. Set `native.host` to a reachable address (a token is
  auto-minted) and restart.
- *Could not determine this host's external address* — a wildcard bind with no
  external IPv4 to advertise. Pass the URL the phone should dial.
