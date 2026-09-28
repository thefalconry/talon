/**
 * Bridge TLS identity — a persistent self-signed certificate + key pair so
 * the client bridge can serve HTTPS and companion clients get an encrypted
 * transport with a pinnable identity.
 *
 * Clients never chain-validate this certificate (there is no CA); they pin
 * its SHA-256 fingerprint on first connect and reject any change afterwards.
 * That makes the certificate a stable device identity, so it is minted once
 * and persisted under ~/.talon/keys/ — regenerating per boot would break
 * every client's pin.
 *
 * The certificate is built locally with node:crypto (ECDSA P-256) and the
 * minimal DER writer below — Node can sign but not mint X.509, and a
 * dependency-free ~100 lines beats pulling in a forge. The output is strict
 * RFC 5280: a v3 certificate whose only extension is a subjectAltName for
 * localhost, so plain `curl --cacert` works against a local bridge too.
 * Structure and usability are locked in by tests: Node's own X509Certificate
 * parser plus a real HTTPS handshake.
 */

import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { log, logWarn } from "../../../util/log.js";

export interface BridgeTlsIdentity {
  /** PKCS#8 private key, PEM. */
  readonly keyPem: string;
  /** Self-signed X.509 certificate, PEM. */
  readonly certPem: string;
  /** SHA-256 of the certificate DER — lowercase hex, no separators. */
  readonly fingerprint: string;
}

const CERT_FILE = "bridge-cert.pem";
const KEY_FILE = "bridge-key.pem";
const COMMON_NAME = "Talon Bridge";
const VALIDITY_DAYS = 3650;
/** Regenerate ahead of expiry so clients re-pin on a calm day, not an outage. */
const RENEWAL_MARGIN_DAYS = 30;

// ── DER writer ──────────────────────────────────────────────────────────────
// Just enough of ITU-T X.690 DER to express one self-signed certificate.

/** Definite-length encoding: short form < 0x80, long form above. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(parts));
}

function derSet(...parts: Buffer[]): Buffer {
  return der(0x31, Buffer.concat(parts));
}

/** Positive INTEGER: prefix 0x00 when the leading bit would read as a sign. */
function derInteger(magnitude: Buffer): Buffer {
  const body =
    (magnitude[0] ?? 0) & 0x80
      ? Buffer.concat([Buffer.from([0x00]), magnitude])
      : magnitude;
  return der(0x02, body);
}

/** OBJECT IDENTIFIER from dotted notation (base-128 arc encoding). */
function derOid(oid: string): Buffer {
  const arcs = oid.split(".").map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const groups: number[] = [];
    let rest = arc;
    do {
      groups.unshift(rest & 0x7f);
      rest >>= 7;
    } while (rest > 0);
    for (let i = 0; i < groups.length - 1; i++) groups[i]! |= 0x80;
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime (RFC 5280 requires it for dates through 2049): YYMMDDHHMMSSZ. */
function derUtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return der(0x17, Buffer.from(text, "ascii"));
}

/** BIT STRING with zero unused bits (all our payloads are byte-aligned). */
function derBitString(body: Buffer): Buffer {
  return der(0x03, Buffer.concat([Buffer.from([0x00]), body]));
}

/** Context-specific constructed tag [n] EXPLICIT. */
function derExplicit(n: number, body: Buffer): Buffer {
  return der(0xa0 | n, body);
}

// ── Certificate construction ────────────────────────────────────────────────

const OID_COMMON_NAME = "2.5.4.3";
const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

/** RDNSequence with a single CN attribute. */
function nameWithCommonName(commonName: string): Buffer {
  return derSequence(
    derSet(
      derSequence(
        derOid(OID_COMMON_NAME),
        der(0x0c, Buffer.from(commonName, "utf-8")), // UTF8String
      ),
    ),
  );
}

/**
 * subjectAltName covering local access: DNS "localhost" + IP 127.0.0.1.
 * Remote clients pin the fingerprint and never check names, so the SAN
 * only needs to satisfy hostname verification for local tooling.
 */
function subjectAltName(): Buffer {
  return derSequence(
    der(0x82, Buffer.from("localhost", "ascii")), // GeneralName: dNSName
    der(0x87, Buffer.from([127, 0, 0, 1])), // GeneralName: iPAddress
  );
}

export interface SelfSignedCertificateOptions {
  readonly commonName?: string;
  readonly validityDays?: number;
  /** Injection point for deterministic tests; defaults to `new Date()`. */
  readonly now?: Date;
}

/** Mint a fresh P-256 key pair + self-signed certificate. */
export function generateSelfSignedCertificate(
  options: SelfSignedCertificateOptions = {},
): { keyPem: string; certPem: string } {
  const commonName = options.commonName ?? COMMON_NAME;
  const validityDays = options.validityDays ?? VALIDITY_DAYS;
  const now = options.now ?? new Date();

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  // Random positive serial; top bits forced so the DER stays minimal-form
  // (no sign padding, no leading zero byte) without special cases.
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40;

  // ECDSA algorithm identifiers carry no parameters (RFC 5758 §3.2).
  const signatureAlgorithm = derSequence(derOid(OID_ECDSA_WITH_SHA256));
  const name = nameWithCommonName(commonName);
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000); // clock-skew slack
  const notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);

  const tbsCertificate = derSequence(
    derExplicit(0, derInteger(Buffer.from([2]))), // version: v3
    derInteger(serial),
    signatureAlgorithm,
    name, // issuer — self-signed, so issuer == subject
    derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
    name, // subject
    publicKey.export({ type: "spki", format: "der" }),
    derExplicit(
      3,
      derSequence(
        derSequence(
          derOid(OID_SUBJECT_ALT_NAME),
          der(0x04, subjectAltName()), // extnValue OCTET STRING
        ),
      ),
    ),
  );

  // For EC keys, sign() already emits a DER Ecdsa-Sig-Value — exactly the
  // payload the certificate's signatureValue BIT STRING carries.
  const signature = createSign("SHA256")
    .update(tbsCertificate)
    .sign(privateKey);
  const certificate = derSequence(
    tbsCertificate,
    signatureAlgorithm,
    derBitString(signature),
  );

  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certPem: toPem("CERTIFICATE", certificate),
  };
}

function toPem(label: string, body: Buffer): string {
  const lines = body.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** SHA-256 of the certificate DER — lowercase hex, no separators. */
export function certificateFingerprint(certPem: string): string {
  return createHash("sha256")
    .update(new X509Certificate(certPem).raw)
    .digest("hex");
}

/**
 * The certificate's public-key pin: base64 SHA-256 of its DER
 * SubjectPublicKeyInfo — the value curl's `--pinnedpubkey sha256//…` checks.
 */
export function certificateSpkiPin(certPem: string): string {
  return createHash("sha256")
    .update(
      new X509Certificate(certPem).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
}

/** AA:BB:… presentation of a fingerprint, for logs and pairing screens. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{2}/g) ?? []).join(":").toUpperCase();
}

/**
 * Whether a configured bind host keeps the bridge on this machine. Decides
 * the TLS default: loopback binds stay plain HTTP, anything else encrypts.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Load the persisted bridge identity, minting (or replacing) it when the
 * files are absent, unreadable, mismatched, or within the renewal margin
 * of expiry. Files live under ~/.talon/keys/ with owner-only permissions.
 */
export async function loadOrCreateBridgeTlsIdentity(
  dir: string = dirs.keys,
): Promise<BridgeTlsIdentity> {
  const certPath = resolve(dir, CERT_FILE);
  const keyPath = resolve(dir, KEY_FILE);

  const existing = await readIdentity(certPath, keyPath);
  if (existing) return existing;

  const { keyPem, certPem } = generateSelfSignedCertificate();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(keyPath, keyPem, { mode: 0o600 });
  await chmod(keyPath, 0o600); // mode above is ignored when the file exists
  await writeFile(certPath, certPem, { mode: 0o600 });
  await chmod(certPath, 0o600);

  const fingerprint = certificateFingerprint(certPem);
  log(
    "native",
    `Minted bridge TLS certificate (${formatFingerprint(fingerprint)})`,
  );
  return { keyPem, certPem, fingerprint };
}

/** The persisted identity, or null when it is missing or no longer usable. */
async function readIdentity(
  certPath: string,
  keyPath: string,
): Promise<BridgeTlsIdentity | null> {
  let certPem: string;
  let keyPem: string;
  try {
    [certPem, keyPem] = await Promise.all([
      readFile(certPath, "utf-8"),
      readFile(keyPath, "utf-8"),
    ]);
  } catch {
    return null; // first boot — nothing persisted yet
  }
  try {
    const cert = new X509Certificate(certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
      logWarn(
        "native",
        "Bridge TLS key does not match its certificate — reminting",
      );
      return null;
    }
    const renewalCutoff =
      Date.now() + RENEWAL_MARGIN_DAYS * 24 * 60 * 60 * 1000;
    if (new Date(cert.validTo).getTime() < renewalCutoff) {
      logWarn("native", "Bridge TLS certificate near expiry — reminting");
      return null;
    }
    return { keyPem, certPem, fingerprint: certificateFingerprint(certPem) };
  } catch (err) {
    logWarn(
      "native",
      `Persisted bridge TLS identity unreadable — reminting (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}
