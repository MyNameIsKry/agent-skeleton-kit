---
inclusion: manual
---

# Kiroween submission checklist

Use with `#submission-checklist` when preparing the release. Re-verify the official rules at https://kiroween.devpost.com/ because the criteria summarized here come from the 2025 edition rules.

## Hard requirements (missing any of these can disqualify)

- [ ] Public GitHub repository.
- [ ] OSI-approved license file at the root, detected by GitHub (license badge visible).
- [ ] `.kiro/` at the repo root, committed, and **not** in `.gitignore` (steering, specs, hooks all present).
- [ ] Demo video under 3 minutes, public on YouTube/Vimeo, shows the app actually running.
- [ ] The project installs and runs as described, verified on a fresh clone in a new directory.
- [ ] Text description explaining how Kiro was used (specs, steering, hooks, and any other feature).

## Judging criteria (equally weighted)

1. **Potential Value:** useful, unique, scalable. Make the "two apps, zero core changes" claim concrete.
2. **Implementation:** depth and variety of Kiro usage. Show the spec-to-task flow, steering rules that changed outcomes, and hooks that guard the architecture.
3. **Quality and Design:** polish. Playground clarity, README, clean code, passing CI.

## README must contain

Hero GIF or screenshot, one-paragraph pitch, architecture diagram, 2-command quick start, tenant creation guide (5 steps), isolation explanation, "How I used Kiro" section linking to `.kiro/specs`, `.kiro/steering`, `.kiro/hooks`, roadmap, license.

## Demo video outline (about 3:00)

| Time | Content |
|---|---|
| 0:00-0:20 | Problem: repeated agent boilerplate. The skeleton idea. |
| 0:20-1:10 | Ops tenant: policy question with citations, unresolved issue, confirmed `create_it_ticket` call. |
| 1:10-1:50 | Switch to E-commerce tenant: return policy answer, `check_order_status`, `request_return`. |
| 1:50-2:15 | Isolation proof: ask the E-commerce tenant an Ops-only question. No knowledge, no such tool. |
| 2:15-2:45 | Architecture diagram, `git diff --stat` showing no `packages/core` changes for the second tenant, quick look at `.kiro/`. |
| 2:45-3:00 | Two-command quick start and call to action. |

## Final verification

- [ ] `git clone` into a clean directory, `cp .env.example .env`, set key, `docker compose up --build`, playground works on first try.
- [ ] CI green (lint, typecheck, unit, isolation, arch, zero-core).
- [ ] No secrets in git history. `.env` ignored.
