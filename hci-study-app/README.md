# Study frontend

React/TypeScript/Vite frontend for the Study 2 research platform.

Start with the repository [README](../README.md) and [setup guide](../docs/SETUP.md). The root Compose configuration builds the frontend and serves it through Caddy; this folder's Dockerfile is a development-server alternative, not the full platform.

For direct development: use Node 22.18 or compatible, run `npm ci`, copy `.env.example` to `.env`, then run `npm run dev`. The local Vite server proxies `/api` to port 8787 and `/chat` to port 8081. Those services must be started separately.

All `VITE_*` variables are embedded in browser code. Never put API keys, database credentials or other secrets in them. Use `npm run build` for a production bundle. The separate `npm run typecheck` command is not part of that build and has outstanding source typing/unused-symbol diagnostics; see the release note.
