# Security

- Never commit a Hyperliquid agent private key, exchange credential, control token, real `.env` file, or target-account mapping containing sensitive material.
- Keep live signing server-side. Do not move secrets or target mappings into browser code.
- Keep simulation as the default. Treat live execution as blocked until server-side arming, target reconciliation, actual-fill accounting, and kill-switch checks pass.
- A private GitHub repository is not a secret manager. Use process-level environment variables or an OS secret store for live credentials.
- Runtime SQLite, WAL, audit logs, and local process state are intentionally ignored.

