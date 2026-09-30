# macOS companion signing

The macOS companion keeps two things in the login keychain: the bridge
credential (`org.talon.companion.bridge`) and the app-lock record
(`org.talon.companion.applock`). The keychain grants an item to the app whose
**designated requirement** created it. An ad-hoc signature (`codesign -s -`)
has no certificate, so its requirement is the binary's own hash — every build
is a new app to the keychain. After each update macOS either asks
"Talon wants to use your confidential information… Allow / Deny", or refuses
outright, and the app lock shows "Talon is locked… can't be read → Reset and
erase".

Signing every release with one persistent certificate fixes that: the
requirement becomes `identifier "…" and certificate leaf = H"…"`, which is the
same for every build signed with that certificate, so keychain items carry
over. The certificate does not need to come from Apple and does not remove
Gatekeeper's first-open warning (that needs a paid Developer ID and
notarization).

## CI

`.github/workflows/companion.yml` ("Set up macOS signing identity") imports
the certificate from two repository secrets into a throwaway keychain, and the
Package step signs `Talon.app` with the identity named **`Talon Companion`**:

| Secret | Contents |
| --- | --- |
| `TALON_MAC_SIGNING_P12` | base64 of the PKCS#12 bundle (certificate + private key) |
| `TALON_MAC_SIGNING_PASSWORD` | the bundle's export password |

Without the secret (pull requests, forks) the build is signed ad-hoc and the
step prints a warning; on a published release it is a `::warning::` annotation.

## One-time certificate creation

Do this once and keep the `.p12` safe: a new certificate is a new designated
requirement, which costs every user one more round of keychain prompts.

```sh
cat > talon-codesign.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Talon Companion
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
  -keyout talon-codesign.key -out talon-codesign.crt -config talon-codesign.cnf

# -legacy: macOS `security import` can't read OpenSSL 3's default PBES2/AES
# PKCS#12 encryption.
openssl pkcs12 -export -legacy -inkey talon-codesign.key -in talon-codesign.crt \
  -name "Talon Companion" -out talon-codesign.p12 -passout pass:'<password>'

base64 < talon-codesign.p12 | gh secret set TALON_MAC_SIGNING_P12 --repo thefalconry/talon
gh secret set TALON_MAC_SIGNING_PASSWORD --repo thefalconry/talon --body '<password>'

shred -u talon-codesign.key 2>/dev/null || rm -P talon-codesign.key
```

Store `talon-codesign.p12` and its password in the team password manager; the
private key is the only copy of the identity. The long lifetime
(`-days 7300`) is deliberate: a renewed certificate is a new leaf hash, i.e.
another round of keychain prompts.

Alternatively, create the certificate in Keychain Access (Certificate
Assistant → Create a Certificate…, name `Talon Companion`, type *Self Signed
Root*, certificate type *Code Signing*) and export it as `.p12`.

## Checking a build

```sh
codesign --display --requirements - /Applications/Talon.app
# designated => identifier "com.example.talonCompanion" and certificate leaf = H"…"
```

A `cdhash H"…"` requirement means the build was signed ad-hoc.

## Upgrading from an ad-hoc build

The first update from an ad-hoc build to a certificate-signed one still
changes the requirement, so it hits the keychain once more. When macOS asks,
enter the login password and choose **Always Allow**; from then on updates
keep working without prompts.
