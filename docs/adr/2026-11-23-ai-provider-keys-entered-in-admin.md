# AI provider keys are entered in /admin, write-only and encrypted

## Context

The owner ruled that the AI draft feature is controlled entirely from /admin, including the provider API key ([SCRUM-979](https://autoflowdealer.atlassian.net/browse/SCRUM-979) rulings 18 and 19). [SCRUM-980](https://autoflowdealer.atlassian.net/browse/SCRUM-980) builds that control for the Anthropic key. An API key is a secret that can spend money with the provider, so where it is stored and who can read it back matters more than the convenience of entering it.

## Decision

- A super admin enters the key on /admin/ai. No function a client can call returns the key, its ciphertext or its IV. The page shows only whether a key is set, its last four characters and the date it was saved.
- The key is stored with AES-256-GCM, a fresh random 96-bit IV for each save, and the provider name as additional authenticated data. The master key is the Convex environment variable `AI_KEY_ENCRYPTION_KEY`. If the master key is missing or malformed, the save is refused and nothing is stored.
- The ciphertext lives in its own table, `aiProviderKeys`. The Data Browser cannot read that table, and no client-facing query returns its rows.
- Every set, replace and remove writes an `adminAuditLog` row with the actor. The row records the last four characters, never the key.
- The key is saved through `aiAdmin.saveProviderKey`, an action the client calls directly. The plaintext exists only in that action's memory. Only the ciphertext reaches the internal mutation that stores it. A mutation cannot be used: its IV would not be random, and a scheduled function would persist its arguments. [Convex actions](https://docs.convex.dev/functions/actions) · [Convex runtimes](https://docs.convex.dev/functions/runtimes)

## Alternatives

Keeping the key only in the backend environment configuration, with a status-only display in /admin, is safer: the key never passes through a browser or a database. It was rejected because every change would need Convex dashboard access, which the owner ruling excludes.

Storing the key in the generic `siteConfig` table was rejected. Its setter writes the raw value to the audit log, and its getter returns values to a client. That is the leak class of [SCRUM-843](https://autoflowdealer.atlassian.net/browse/SCRUM-843).

## Consequences

- This is the first data the repository encrypts at rest.
- Each deployment needs `AI_KEY_ENCRYPTION_KEY` set before a key can be saved. Until then /admin/ai says so and disables saving.
- The OWASP Cryptographic Storage Cheat Sheet advises against keeping encryption keys in environment variables. We accept that departure because Convex offers no key management service, and its environment variables are a secret store separate from the table that holds the ciphertext. [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) · [Convex environment variables](https://docs.convex.dev/production/environment-variables)
- To rotate the provider key, a super admin enters a new one. The stored `keyVersion` field is reserved for rotating the master key, which has no procedure yet.
