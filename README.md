# # What Is This Repository

Research platform accompanying Figliè et al. (2026), *Neither Replacement nor Panacea: Comparing LLM-Based Conversational and Graphical Decision Support in Industrial Tasks*. It implements the dashboard and conversational conditions, shared industrial scenario, study flow, questionnaires, task scoring, and event logging, used for the study.

This is the **platform repository**, the separate analyses repository is available [here](https://github.com/onirob/CUIvsGUI_analysis). It contains synthetic scenario data and experimental materials, but no participant records or original deployment credentials. The article is the primary methodological reference.

## Local setup

Use Docker Desktop (Linux containers) or Docker Engine with Compose v2.

1. Copy `.env.example` to `.env`.
2. Generate fresh database and IP-hashing secrets using [the setup guide](docs/SETUP.md#configuration).
3. For model responses, add your own Azure OpenAI endpoint, API key and GPT-4o deployment. Azure credentials remain server-side. Without these, dashboard exploration is available and chatbot requests report missing configuration.
4. Run `docker compose up --build -d`. The database initializes and loads the synthetic scenario before the API starts.
5. Open the local platform (http://127.0.0.1:8080, or http://localhost) on a desktop browser. Artificial participant identities are enabled; original-study redirects and contact actions are disabled.

The supplied configuration is for local exploration, not public participant recruitment. See [setup and troubleshooting](docs/SETUP.md) before using it.

## Architecture

| Component | Purpose |
| --- | --- |
| `hci-study-app/` | React/TypeScript frontend: dashboard, chatbot UI, task flow and questionnaires |
| `hci-study-api/` | FastAPI: sessions, assignment, shared data retrieval, scoring and logging |
| `hci-study-chatbot-api/` | FastAPI and Azure GPT-4o: prompts and retrieval tools |
| `reverse-proxy/` | Caddy: serves the frontend and routes `/api` and `/chat` |
| `seed_data/` | 16 synthetic machine histories and decision ground truth |
| `services/db-backup/` | Optional local backup/export service; disabled by default |

Only the reverse proxy is exposed, bound to `127.0.0.1:8080`. PostgreSQL, the study API and the chatbot communicate within the isolated Compose project.

## Research materials

- [Experimental flow and implementation map](docs/EXPERIMENT.md)
- [Data provenance and public-release changes](docs/DATA_AND_RELEASE.md)
- [Security and handling newly collected records](SECURITY.md)

**Scenario clock:** 5 November 2025 at **11:30 Europe/Rome** (10:30 UTC), as implemented in the platform and explained in the article.


Documentation and human-readable source text are in English, including translated legacy chatbot questions. Executable identifiers and author attribution are retained. See the [language-update note](docs/DATA_AND_RELEASE.md#english-language-update) for the scope of the translation.

## Attribution

Article authors: Roberto Figliè, Simone Caputo, Alan Serrano, Daria Mikhaylova, Tommaso Turchi and Daniele Mazzei.

The original [MIT license](LICENSE), including Roberto Figliè's copyright notice, is retained. Cite the article when using the experimental design or reporting work based on this platform. Third-party dependencies retain their own licenses.
