# Setup and local exploration

## Requirements

The recommended route uses Docker Compose v2 and Linux containers. Images use PostgreSQL 16, Python 3.11, Node 22 and Caddy 2. Initial builds need internet access to obtain images and dependencies. The supplied synthetic data occupies approximately 129 MB; database loading needs additional disk space and time.

This guide describes the prepared local configuration. The owner confirmed that the original platform was runnable and requested no further runtime checks during release preparation. A fresh end-to-end run of this public configuration is not claimed.

## Configuration

From the repository root, copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`). Generate two independent secrets, for example by running this command twice in a Python installation:

```console
python -c "import secrets; print(secrets.token_hex(32))"
```

Place one value in `POSTGRES_PASSWORD` and the other in `IP_HASH_SALT`. Do not reuse original-study credentials. Use hexadecimal values here so the password can also appear safely in a PostgreSQL connection URI. Do not publish `.env` or screenshots of it.

| Root setting | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Fresh password for this isolated PostgreSQL database |
| `IP_HASH_SALT` | Fresh server-side salt used for IP hashing; hashing is not anonymization |
| `LOCAL_PORT` | Local entry port, default `8080`; still bound to `127.0.0.1` |
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI resource endpoint, e.g. `https://YOUR-RESOURCE.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Your server-side Azure key |
| `AZURE_OPENAI_DEPLOYMENT` | Your deployment name, which should serve GPT-4o; default `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | Original configured API version, `2024-08-01-preview` |
| `VITE_ENABLE_EXTERNAL_ACTIONS` | `false` by default; deliberately opt in only for a separately configured study |
| `VITE_SUPPORT_EMAIL` | Replacement public contact; blank by default |
| `VITE_PROLIFIC_*_CODE` | Replacement completion/return codes; blank by default |

Azure deployment names are resource-specific, not necessarily model names. Confirm your resource supports the supplied API version and GPT-4o deployment before use. Changing the model, deployment snapshot or API version may change responses and is a replication change to record. The original temperature and already-English prompts are retained; remaining Italian text has been translated as described in the release note. No live model responses were tested during release preparation.

Root Compose passes credentials only to server services. Frontend `VITE_*` settings are public, build-time values, **not secret storage**. Rebuild the proxy after changing them. External actions need both explicit enablement and appropriate replacement values. Local artificial-identity mode also retains the frontend's existing protections against ordinary completion/contact actions. Do not use it to test real payments or recruitment.

The examples inside component folders are for direct execution only; root Compose does not load them. The API needs `DATABASE_URL` and `IP_HASH_SALT`; it deliberately fails on missing values or unchanged placeholders. `DATABASE_URL` must be a native PostgreSQL URI, not a SQLAlchemy `postgresql+psycopg://` URL.

## Start and seed

```console
docker compose up --build -d
```

The Compose project is named `hci-study2-public`. It creates its own database volume, with no access to the original deployment or database. PostgreSQL initializes the schema from `hci-study-api/app/sql/init.sql`. The one-shot `db-seed` service reads `seed_data/`, loads the machine histories, and upserts decision ground truth. The API waits for successful seeding.

Open `http://127.0.0.1:8080` on a desktop/laptop browser. There is no tester password in this public copy. Without Azure settings, the chatbot health endpoint can respond but actual chat requests cannot produce model responses; the dashboard does not require Azure.

The seeder skips time-series loading when any time-series row already exists. An interrupted initial import may therefore leave an incomplete dataset on restart. Use a genuinely fresh, isolated database for the first import; do not assume a successful restart repairs a partial import. Never substitute a production dump. Database seeding is not an analysis rerun.

## Explore both interfaces

Opening the local site without Prolific parameters generates an artificial `dev_...` participant identity. An explicit local identity can be supplied with `/?dev=1&FAKE_PID=local-demo-001`. Use a new artificial value and a fresh browser session for each complete walkthrough; the original protections against duplicate/finished sessions remain in place.

Follow consent, prescreening, literacy and familiarity questionnaires, allocation, familiarization, and the task/questionnaire sequence. The consent and payment wording is historical experimental material, not an invitation to participate or an offer of payment. A public-copy notice is shown above it.

Allocation is performed by the original server algorithm; a new session is not guaranteed to receive the opposite interface. Use additional artificial identities to encounter both conditions without modifying allocation. The existing `VITE_FORCE_INTERFACE` option is a frontend-only development override and can disagree with the arm stored by the server. Leave it empty for faithful walkthroughs; it has not been used for the experimental assignment.

Dashboard interaction and questionnaire navigation do not spend Azure credits. Submitting an actual chatbot message with valid Azure configuration does. For offline inspection, read the retrieval tools and prompts rather than submitting messages. Model responses may differ across runs and deployments.

## Optional backups and stopping

Backups are off by default. To enable the retained local backup/export service:

```console
docker compose --profile backup up -d db-backup
```

It writes to `backups/`, which is excluded from Git and Docker build contexts. Exports can include participant responses and chat content; this exclusion must never be removed. The backup schedule is local to this project. No original-deployment monitoring workflow is included.

Stop the ordinary services with `docker compose down`. If backups were enabled, use `docker compose --profile backup down`. These commands retain the database volume. Do not add volume-deletion flags unless you deliberately intend to erase the local records. Do not upload that volume or its exports.

## Direct development

For the frontend, use Node 22.18 or compatible, `npm ci`, and `npm run dev` in `hci-study-app/`. Vite binds to `127.0.0.1:5173` and proxies API/chat requests to local ports 8787/8081. Run `npm run build` for the production bundle. Its separate TypeScript check has outstanding diagnostics documented in the release note.

For each Python service, use a separate Python 3.11 virtual environment and install its own `requirements.txt`. The study API uses NumPy 2 for the supplied pickles; the chatbot retains its existing NumPy 1.26.4 requirement. Do not combine these environments. Copy that component's `.env.example` to `.env` and fill in its local values.

Run the API from `hci-study-api/` with `uvicorn app.main:app --host 127.0.0.1 --port 8787`. Initialize a fresh local PostgreSQL database using `app/sql/init.sql` and run `python app/seeders/seed_machines.py` with the matching `DB_*` and `SEED_DATA_DIR` settings. Run the chatbot from `hci-study-chatbot-api/` with `uvicorn app.main:app --host 127.0.0.1 --port 8081`. Its prompt/template paths are relative to that working directory, and `STUDY_API_BASE_URL` must be an absolute URL ending in `/api`.

## Troubleshooting

- **Unchanged secret placeholder / missing configuration:** fill in fresh root `.env` values. Compose rejects missing required variables; the API also rejects placeholders.
- **Database authentication after changing a password:** PostgreSQL initialization settings only create credentials on an empty volume. Changing `.env` does not change the password of an existing database. Do not point this release at another study database to work around it.
- **Blank dashboard or API errors:** allow initial seeding to finish and consult the local service logs. Do not share logs publicly; they may contain study responses. Check the local proxy and the complete seed import before changing data.
- **Missing Prolific parameters or old state:** use the root local configuration and a fresh artificial identity/browser session. Keep the original duplicate-session rules intact.
- **Chat reports missing Azure settings:** provide your own endpoint, key and deployment to the chatbot service, then recreate it. Do not put the key in frontend settings.
- **Chat API cannot retrieve data:** use `http://api:8787/api` inside Compose; use `http://127.0.0.1:8787/api` for direct local execution. `/api` alone is not a valid server-to-server base URL.
- **Prompt assets not found:** start the chatbot from its component root.
- **Port already used:** change `LOCAL_PORT`; do not remove the loopback binding.
