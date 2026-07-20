# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| Older branches | ❌ |

Only the current `main` branch receives security fixes. Please update to the latest commit before reporting.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

This application handles encrypted brokerage credentials and places real financial orders. Please report security issues privately so they can be fixed before public disclosure.

### Preferred: GitHub private security advisory

1. Go to **[Security → Report a vulnerability](https://github.com/Open-Source-Trader/0dteTrader/security/advisories/new)** in this repository.
2. Fill in a description, affected component, and reproduction steps.
3. We will acknowledge your report within **48 hours** and aim to publish a fix within **14 days** for critical issues.

### Alternative: email

Send details to **security@0dtetrader.dev** with the subject line `[SECURITY] <brief description>`.

Please include:

- A description of the vulnerability and its potential impact
- The affected component (API, iOS app, desktop app, CI)
- Steps to reproduce or a proof-of-concept (sanitised — no real credentials)
- Your GitHub handle if you'd like credit in the advisory

## Scope

### In scope

- Authentication and JWT handling (`apps/api/src/auth/`)
- Credential encryption / decryption (`apps/api/src/webull/`)
- Order execution safety controls
- Dependency vulnerabilities with a realistic attack path
- Secrets accidentally committed to the repository

### Out of scope

- Issues requiring physical access to a device
- Social engineering
- Denial-of-service without demonstrated impact on trading safety
- Theoretical vulnerabilities without a realistic exploit path

## Security design

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model, including:

- AES-256-GCM credential encryption
- Argon2id password hashing
- JWT rotation and refresh-token reuse detection
- iOS Keychain storage and certificate pinning
- Order idempotency and server-side re-validation

## Disclosure policy

We follow **coordinated disclosure**. Once a fix is ready, we will:

1. Publish a GitHub Security Advisory with a CVE (if applicable).
2. Credit the reporter (unless they prefer to remain anonymous).
3. Release a patched version and note the fix in `CHANGELOG.md`.

Thank you for helping keep 0dteTrader and its users safe.
