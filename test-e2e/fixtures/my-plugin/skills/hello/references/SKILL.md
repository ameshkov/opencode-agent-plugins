---
name: nested
description: Nested SKILL.md used to probe the host scan depth for each release.
---

# Nested

A stray `SKILL.md` deeper than `skills/<name>/SKILL.md`. The plugin never
registers it as a skill, and V2 registers skills individually, so the host
never sees it either — the e2e test pins that per release.
