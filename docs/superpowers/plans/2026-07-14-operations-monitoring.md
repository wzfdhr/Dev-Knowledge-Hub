# Operations Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a five-minute host monitor for application, database, disk, and backup freshness.

**Architecture:** A Bash monitor reads only non-secret configuration plus the existing protected
Restic environment, emits sanitized JSON status, and is invoked by a hardened systemd timer.

**Tech Stack:** Bash, systemd, Docker Compose, Restic, Node.js JSON parsing.

## Global Constraints

- Never print backup credentials, passwords, repository URLs containing credentials, or archive content.
- Fail closed when a required check cannot run.
- Do not require a third-party notification service.

---

### Task 1: Add monitor script and focused tests

**Files:**
- Create: `scripts/monitoring/devkh-monitor.sh`
- Create: `scripts/monitoring/monitor.test.mjs`

- [ ] Test healthy and failed-check status output with fake `curl`, `docker`, `restic`, `df`, and `node` commands.
- [ ] Implement HTTP, Compose, disk, and Restic freshness checks with atomic sanitized status writes.
- [ ] Run `node --test scripts/monitoring/monitor.test.mjs`.

### Task 2: Add hardened service and timer

**Files:**
- Create: `deployment/monitoring/monitor.env.example`
- Create: `deployment/monitoring/devkh-monitor.service`
- Create: `deployment/monitoring/devkh-monitor.timer`

- [ ] Add systemd hardening, root-only environment files, and five-minute persistent scheduling.
- [ ] Verify units with `systemd-analyze verify` after deployment.

### Task 3: Deploy and validate

- [ ] Install scripts, unit files, and the root-only environment file without replacing backup secrets.
- [ ] Start the monitor once and confirm a successful sanitized status document.
- [ ] Enable the five-minute timer and verify application health remains unchanged.
