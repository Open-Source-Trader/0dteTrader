# One-Click Self-Hosted Backend (Railway) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A user can press "Deploy on Railway" and get a fully working private backend with zero manual configuration, then point the desktop and iOS apps at it (or at any already-hosted backend) from a Server field on the login screen — no rebuild, no file edits. Closes [#59](https://github.com/Open-Source-Trader/0dteTrader/issues/59).

**Architecture:** Three legs. (1) **API — zero-config secrets:** on boot, when `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `CRED_ENCRYPTION_KEY` are absent, generate them once and persist in a new `RuntimeSecret` Postgres table; env vars always win when present. This removes every prompted variable from the Railway template, making it truly one-click (Railway strips generator defaults from user-service template variables, so deploy-time generation cannot be expressed in the template itself). (2) **Railway template:** already generated (code `Bo-g1p`) from source project `0dtetrader-template` (`af58f654-8a96-4f9e-9fd9-4e073886f9b8`) — API service builds `apps/api/Dockerfile` via the committed `railway.json`, plus Postgres and Redis with volumes. Remaining work: drop the three secret vars from the source project, regenerate, fix the source project's 502, keep the template's repo (`TradeWithCash2025/0dteTrader` mirror) auto-synced from `Open-Source-Trader/0dteTrader` via a GitHub Action, publish, and add the README button + self-hosting docs. (3) **Clients — runtime server selection:** both apps currently bake the API URL at build time (`apps/desktop/src/app/config.ts` reads `VITE_API_BASE_URL`; iOS `GeneratedEnvironment.swift` is generated from `.env`). Add a persisted server URL (desktop: `localStorage`; iOS: `UserDefaults`) that overrides the build-time default, editable from the login screen with a `/v1/health` connection test and a "Deploy on Railway" link.

**Tech Stack:** NestJS + Prisma (API), React/Vite + MobX-style stores (desktop), SwiftUI (iOS), Railway GraphQL API (`backboard.railway.com/graphql/v2`, token in `~/.railway/config.json`), GitHub Actions (mirror sync).

**Design decisions already made (do not relitigate):**

- Secrets fallback lives in Postgres. Tradeoff: `CRED_ENCRYPTION_KEY` stored beside the ciphertext it protects — acceptable for self-hosters, and anyone wanting stricter separation sets env vars, which always take precedence. The official deployment sets env vars and is completely unaffected.
- The template points at the `TradeWithCash2025/0dteTrader` mirror because the Railway account's GitHub connection cannot see the `Open-Source-Trader` org. A CI mirror-sync keeps it current. If the owner later installs Railway's GitHub App on the org, repoint the template source and delete the workflow.
- Desktop is the reference UI; iOS copies its layout (repo rule: always update both).
- Server changes take effect by recreating the app container at save time, before login — no restart required.

**Existing facts an implementer needs:**

- API global prefix is `v1` → health endpoint is `/v1/health` (`apps/api/src/main.ts:17`).
- `apps/api/src/config/configuration.ts` throws in production when `CRED_ENCRYPTION_KEY` is not base64 for exactly 32 bytes (line ~167) and reads secrets from `process.env` (line ~91).
- `NODE_ENV=production` is baked into `apps/api/Dockerfile` (committed `df8c285` with `railway.json`).
- Desktop wiring: `apps/desktop/src/app/container.ts:29-31` constructs `SessionStore`/`ApiClient`/`QuoteSocket` from `API_BASE_URL`/`STREAM_URL` (both from `apps/desktop/src/app/config.ts`).
- iOS wiring: `apps/ios/0dteTrader/App/AppContainer.swift:19-25` from `AppConfig.apiBaseURL`/`streamURL` → `AppEnvironment.current` → `GeneratedEnvironment.apiBaseURL`.
- Railway API calls: `TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.railway/config.json'))['user']['token'])")`, POST JSON to `https://backboard.railway.com/graphql/v2` with `Authorization: Bearer $TOKEN`. Always pipe the body via stdin (`echo "$1" | curl -d @-`) and pass `-m 25`.
- IDs: project `af58f654-8a96-4f9e-9fd9-4e073886f9b8`, environment `e601e668-3002-4e2f-97ce-58b4bf2c20c5`, api service `29807bc0-635a-4c14-ba07-8a200da1d6cc`, workspace `2d1f101b-ef2d-4a4f-adca-5f30b3761243`, current template id `85826cd6-8de9-4fa7-a3aa-a363b342298c` code `Bo-g1p`, source-project domain `api-production-f9d0d.up.railway.app`.
- **Open bug:** that domain returns 502 even though the deployment is SUCCESS, the app logs a clean Nest boot, the app listens on port 3000 (config default, no `PORT` var set), and the domain's `targetPort` is 3000. Production (`caring-prosperity-production.up.railway.app`, same Dockerfile) returns 200. Task 8 diagnoses this; suspects, in order: Nest binding to IPv4 only inside Railway's IPv6 private mesh (`app.listen(port)` vs `app.listen(port, '::')`), edge propagation, targetPort auto-detect mismatch. Compare the production service's domain config (`project c66e9da4-6c01-4dc1-9181-179ee541022f`, service `81f3114d-77d4-46c1-9ea8-89dbb9e1231b`, env `a2a87cba-f9bf-47c5-a2a8-c98dbd38e554`) before changing code.

---

## Phase A — API: zero-config secret bootstrap

### Task 1: `RuntimeSecret` Prisma model + migration

**Files:**

- Modify: `apps/api/prisma/schema.prisma` (append model)
- Generated: `apps/api/prisma/migrations/<timestamp>_runtime_secrets/`

**Step 1: Append the model to `schema.prisma`**

```prisma
/// Server-generated fallback secrets for zero-config self-hosted deploys.
/// Only consulted when the corresponding env var is absent.
model RuntimeSecret {
  name      String   @id
  value     String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("runtime_secrets")
}
```

**Step 2: Create the migration (Docker Postgres must be up: `npm run db:up`)**

Run from `apps/api/`: `set -a; . ../../.env; set +a; npx prisma migrate dev --name runtime_secrets`
Expected: new migration folder, `prisma generate` runs clean.

**Step 3: Commit**

```bash
git add apps/api/prisma
git commit -m "api: RuntimeSecret table for zero-config secret bootstrap (#59)"
```

### Task 2: secret bootstrap service (TDD)

**Files:**

- Create: `apps/api/src/config/secret-bootstrap.ts`
- Test: `apps/api/src/config/secret-bootstrap.spec.ts`

Behavior contract:

- `bootstrapSecrets(prisma)` runs before Nest config validation (call it from `main.ts` bootstrap, before `NestFactory.create`, using a throwaway `PrismaClient`).
- For each of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (generate: `crypto.randomBytes(48).toString('base64url')`) and `CRED_ENCRYPTION_KEY` (generate: `crypto.randomBytes(32).toString('base64')` — must satisfy the existing base64/32-byte production check):
  - env var set → do nothing (env wins; never write to DB).
  - env var absent, row exists → `process.env[name] = row.value`.
  - env var absent, no row → generate, insert (use `upsert`/`ON CONFLICT DO NOTHING` then re-read, so two racing replicas converge on one value), assign to `process.env`.
- Never log the values.

**Step 1: Write failing tests** (`secret-bootstrap.spec.ts`, mock Prisma with an in-memory map; follow existing spec style, e.g. `apps/api/src/health/health.controller.spec.ts`). Cases: env-wins, loads-existing, generates-and-persists, generated `CRED_ENCRYPTION_KEY` decodes to exactly 32 bytes, race convergence (second call returns first call's value).

**Step 2:** Run `npm test --workspace apps/api -- secret-bootstrap` → expect FAIL (module missing).

**Step 3:** Implement minimal `secret-bootstrap.ts`.

**Step 4:** Re-run → PASS. Also run the full API suite: `npm test --workspace apps/api`.

**Step 5: Wire into `apps/api/src/main.ts`** ahead of app creation; skip silently when `DATABASE_URL` is unset (unit-test contexts). Add one boot log line: `secret_bootstrap {generated: [...names]} ` (names only, never values).

**Step 6:** Commit: `api: auto-generate JWT/cred secrets on first boot when env unset (#59)`.

### Task 3: prove the container works with no secret env vars

**Step 1:** Locally: `docker compose up -d`, then run the API with `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`CRED_ENCRYPTION_KEY` unset and `NODE_ENV=production` → boots, `/v1/health` 200, register + login round-trip works (`curl` the auth endpoints; see `apps/api/src/auth` DTOs for shapes).
**Step 2:** Restart the API → same secrets loaded from DB (login session from step 1 still refreshable).
**Step 3:** Commit any fixes.

## Phase B — Railway template finalization

### Task 4: mirror-sync GitHub Action

**Files:**

- Create: `.github/workflows/sync-railway-mirror.yml`

```yaml
name: Sync Railway template mirror
on:
  push:
    branches: [main]
jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Push main to TradeWithCash2025/0dteTrader
        run: |
          git push "https://x-access-token:${{ secrets.MIRROR_PUSH_TOKEN }}@github.com/TradeWithCash2025/0dteTrader.git" main:main
```

Requires the user to add a `MIRROR_PUSH_TOKEN` repo secret (fine-grained PAT, contents:write on the mirror) — surface this as a checklist item for them; the workflow no-ops with a clear failure until then. Commit: `ci: mirror main to Railway template repo (#59)`.

### Task 5: strip prompted secrets from the template and regenerate

**Step 1:** Via Railway GraphQL, `variableDelete` `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CRED_ENCRYPTION_KEY` on the api service (IDs above). Keep `DATABASE_URL`, `REDIS_URL`, `API_BASE_URL` (reference-style values survive template generation).
**Step 2:** Push the Phase-A commits to `origin main` **and** the mirror (or merge the PR first — see Task 12 ordering note), redeploy the source api service, confirm it boots with DB-generated secrets (`railway logs --service api` from the linked scratchpad dir shows `secret_bootstrap`).
**Step 3:** `templateDelete` the old template (`85826cd6…`, needs `input:{workspaceId}`), then `templateGenerate` → verify `serializedConfig` api service has **no prompt-only variables** (every variable has a `defaultValue`) and healthcheck `/v1/health`.
**Step 4:** Record the new template id/code in the docs (Task 7).

### Task 6 (Task 8 prerequisite may reorder): fix the source-project 502

**Step 1:** Read the production service's domain (`domains` query with prod IDs above) and diff against the template project's (`targetPort`, count). Diff rendered variables (`PORT` especially).
**Step 2:** Apply the difference to the template project (likely `serviceDomainUpdate` targetPort or removing it for auto-detect) — not code — and re-curl `/v1/health` until 200. If and only if evidence shows an IPv6 bind issue, change `apps/api/src/main.ts` to `app.listen(port, '::')` (verify production still works after — it will, dual-stack) and commit: `api: bind dual-stack for Railway private networking (#59)`.
**Step 3:** Success criterion: `curl https://api-production-f9d0d.up.railway.app/v1/health` → 200.

### Task 7: README button + self-hosting docs

**Files:**

- Modify: `README.md` (add a "Self-hosting" section near the top)
- Create: `docs/self-hosting.md`

README snippet (use the final template code from Task 5):

```markdown
## Host your own backend

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<CODE>)

One click deploys the API + Postgres + Redis to your own Railway account — no configuration needed.
Then open the app, tap **Server** on the login screen, and paste your Railway URL.
See [docs/self-hosting.md](docs/self-hosting.md) for the full walkthrough.
```

`docs/self-hosting.md` covers: what gets created and rough monthly cost, the deploy walkthrough, where to find the public URL, pasting it into desktop/iOS (screenshots optional), how secrets work (auto-generated, stored in _your_ database; how to override with env vars), how updates flow (redeploy from the Railway dashboard picks up latest main), and troubleshooting (`/v1/health`, deploy logs). Commit: `docs: self-hosting guide + Railway deploy button (#59)`.

## Phase C — Desktop: runtime server selection

### Task 8: `ServerConfigStore` (TDD)

**Files:**

- Create: `apps/desktop/src/core/api/ServerConfigStore.ts`
- Test: `apps/desktop/src/core/api/ServerConfigStore.spec.ts`
- Modify: `apps/desktop/src/app/config.ts`, `apps/desktop/src/app/container.ts`

Contract: `ServerConfigStore.load()` returns `localStorage['serverBaseUrl']` if set and parseable as http(s) URL, else the build-time `VITE_API_BASE_URL` default; `save(url)` normalizes (trim, strip trailing `/` and any `/v1` suffix), validates, persists; `reset()` clears back to default; `streamUrlFor(baseUrl)` reuses the existing http→ws derivation (move the logic from `config.ts` into a pure exported function so both use it — keep `config.ts` exporting `DEFAULT_API_BASE_URL`).

Steps: failing tests (valid save, junk rejected, `/v1` suffix stripped, default fallback, stream derivation https→wss) → run (`npm test --workspace apps/desktop -- ServerConfigStore`) → implement → pass → rewire `container.ts` to construct from `ServerConfigStore.load()`, add `AppContainer.recreate()` (or construct the container after server confirmation — inspect `apps/desktop/src/app` entry to pick the least invasive: the container is currently a module singleton; prefer a `configureContainer(baseUrl)` factory called at startup and again on save) → full desktop suite → commit `desktop: runtime server selection store (#59)`.

### Task 9: Server section on `LoginView`

**Files:**

- Modify: `apps/desktop/src/features/auth/LoginView.tsx` (154 lines — read fully first, match its form styling)
- Create: `apps/desktop/src/features/auth/ServerSettings.tsx`

Collapsed row under the login form: "Server: `<current host>`" with an Edit affordance. Expanded: URL field, **Test connection** button (fetch `<url>/v1/health`, 4s timeout → ✓ reachable / ✗ with reason), **Save** (persists via store, recreates container), **Reset to default**, and a "Deploy on Railway" link (the template URL) with one line: "No backend yet? Deploy your own in one click, then paste its URL here." Tests: component test for validation + health-check state rendering (mock fetch), follow existing desktop test patterns. Commit: `desktop: server picker on login with health check (#59)`.

## Phase D — iOS: runtime server selection (mirror of C)

### Task 10: `ServerConfigStore.swift`

**Files:**

- Create: `apps/ios/0dteTrader/Core/Storage/ServerConfigStore.swift`
- Test: `apps/ios/Tests/ServerConfigStoreTests.swift` (locate the existing test target dir with `ls apps/ios` / `project.yml` and match it)
- Modify: `apps/ios/0dteTrader/App/AppConfig.swift`, `AppContainer.swift`, `ZeroDTETraderApp.swift`

Same contract as desktop: `UserDefaults` key `serverBaseURL`, fallback `AppEnvironment.current.apiBaseURL`, same normalization rules, stream derivation via the existing `AppEnvironment.streamURL` logic extracted to work on any base URL. `AppContainer` becomes constructible with a `baseURL:` parameter; the app holds it in `@State`/environment and rebuilds it on server change (find how `AppContainer` is instantiated in `ZeroDTETraderApp.swift` and keep the change minimal). Note: TLS pinning (`CertificatePinning.swift`) must be bypassed/empty for user-supplied hosts — pinned hashes only apply to the built-in default host; assert that in a test. TDD steps as usual; build with `xcodegen && xcodebuild build -scheme 0dteTrader -destination 'generic/platform=iOS Simulator'`; run tests on a device from `xcrun simctl list devices available`. Commit: `ios: runtime server selection store (#59)`.

### Task 11: Server section on iOS `LoginView`

**Files:**

- Modify: `apps/ios/0dteTrader/Features/Auth/LoginView.swift` (+ `AuthComponents.swift` if a shared field style exists)
- Create: `apps/ios/0dteTrader/Features/Auth/ServerSettingsView.swift`

Mirror the desktop layout exactly (repo rule): collapsed server row → sheet/disclosure with URL field, Test connection (async `/v1/health`), Save, Reset, Deploy-on-Railway `Link`. Commit: `ios: server picker on login with health check (#59)`.

## Phase E — End-to-end verification & landing

### Task 12: end-to-end proof

Ordering note: Tasks 5–6 need Phase A on the mirror's `main`. Either land the PR first and then finalize the template (preferred: template steps are config, not code), or push the branch to the mirror temporarily. Prefer: finish code review → merge PR → run Tasks 5–7 against merged main → verify.

Checklist (all must pass, mirroring #59's acceptance criteria):

- [ ] Fresh template deploy on Railway reaches healthy with **zero prompts** and zero file edits; `/v1/health` 200 on its public URL.
- [ ] Register + login against that instance from the **desktop** app after pasting the URL; restart app → server persisted, session works.
- [ ] Same from **iOS** (simulator), including WebSocket stream connect.
- [ ] Redeploy of the instance keeps secrets stable (login survives) and re-runs migrations.
- [ ] Official-backend default is untouched: both apps with no stored override still hit the built-in URL.
- [ ] `npm run test`, `npm run lint`, iOS build all green.
- [ ] Delete the throwaway user-side test project.

### Task 13: PR + issue close-out

PR from `feature/59-one-click-backend` → `main` titled "One-click self-hosted backend: Railway template + runtime server selection (#59)"; body maps changes to #59's acceptance criteria, notes the two user actions (add `MIRROR_PUSH_TOKEN` secret; optionally install Railway GitHub App on the org and repoint the template), and the publish step (`templatePublish` needs category/description/readme — get explicit owner approval before publishing, since it lists the template publicly). Comment on #59 with the template URL and what shipped.
