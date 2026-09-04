---
name: hello
description: A user-authored hello skill shadowing the plugin's.
---

# Hello

A user-authored fixture skill whose name (`hello`) collides with the skill of
the `my-plugin` e2e fixture. It must win over the plugin registration, which
is skipped and reported at plugin startup (§3.2, §5.6).
