# Lessons Learned

Record corrections, mistakes, and insights during development.
Update this file after any significant debugging session or course correction.

## Format

Each entry: date, what went wrong (or what was learned), and the takeaway.

---

### YYYY-MM-DD — (Template Entry)

**What happened:** Describe the mistake or unexpected behavior.

**Root cause:** What actually caused it.

**Lesson:** What to do differently next time.

---

### 2026-07-19 — Deploy backend via Railway, never build locally

**What happened:** GitHub Actions was blocked (billing failure), so production was stale. Attempted to build the Docker image locally and push to GHCR; user corrected: nothing runs locally — the backend lives on Railway.

**Root cause:** Assumed the GHCR pipeline had to be replicated locally instead of using Railway's own cloud build.

**Lesson:** When CI can't deploy, use `railway up --service caring-prosperity` from the repo root — the service already has `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` set, so Railway builds in its cloud with the correct context. Verify with `GET /v1/health` (fresh `uptime` = new container). Don't start Docker Desktop for backend deploys.

---
