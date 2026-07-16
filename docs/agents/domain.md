# Domain docs

NanoClaw uses a single domain context.

## Before exploring

- Read root `CONTEXT.md` when it exists.
- Read relevant records under root `docs/adr/` when that directory exists.
- If either is absent, proceed silently. Producer workflows create them only when a durable domain term or architectural decision warrants it.

Use the glossary's canonical terms in issues, tests, hypotheses, and implementation notes. Surface conflicts with an ADR explicitly rather than silently overriding it.

Private feature decisions remain authoritative in their `.scratch/<feature>/MAP.md` and linked tickets until the feature is accepted for implementation. Promote only durable, cross-feature language to `CONTEXT.md`, and only hard-to-reverse, surprising trade-offs to `docs/adr/`.
