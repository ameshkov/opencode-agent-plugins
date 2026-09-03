---
name: nested
description: Nested SKILL.md used to probe the host scan depth for each release.
---

# Nested

A stray `SKILL.md` deeper than `skills/<name>/SKILL.md`. The plugin never
registers it as a skill; whether the host exposes it depends on the pinned
opencode release's scan depth, which the e2e test pins per release.
