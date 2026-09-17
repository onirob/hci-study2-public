# Data provenance and public-release note

## Included material

The supplied scenario contains **16 synthetic machine histories**, totaling **467,696 time-series rows**, and **2,533 decision-ground-truth rows**. These are experimental inputs, not participant observations or results. The article describes the construction of the synthetic industrial scenario; this repository distributes the supplied scenario used by the platform, not the underlying private industrial source traces or a newly generated replacement.

Each `seed_data/asset-*.pkl` contains machine metadata and a pandas DataFrame. Metadata includes the public machine ID and name, scenario dates, frequency, timezone, cycle/anchor parameters and alarm statistics. The time-series include production, machine-state duration, energy, cost and efficiency measures. `seed_data/manifest.json` lists files, row counts, column names, UTC timestamp bounds and SHA-256 hashes.

`decision_ground_truth.csv` contains task codes, machine-name/date responses and decision scores. Those values were preserved. Machine display names and frontend answer codes were retained so scoring continues to refer to the same decisions. The release does not recompute ground truth, task outcomes or article analyses.

Pickles can execute code when loaded. Load only trusted copies of these files; do not accept arbitrary uploaded pickles. The release preserves the original pandas/NumPy serialization and numeric buffers while replacing string identifiers. Keep the API's compatible dependency environment separate from the chatbot's environment.

## Excluded material

- Original Git history and repository configuration, including remotes.
- Real environment files, credentials, cloud resource endpoints, private deployment addresses and workspace identifiers.
- The complete backups/analytics collection, database dumps, logs and participant exports.
- The separate workspace-named pickle formerly present under the study API routes, whose provenance was unclear.
- Installed dependencies, generated builds, caches, local editor state and temporary preparation files.
- The scheduled workflow that contacted the original study deployment and the redundant chatbot-specific Compose configuration.

No participant records are intentionally included. 

## Sanitization

Original asset identifiers were consistently replaced with public `asset-...` identifiers in filenames, pickle metadata, the DataFrame's identifier column and code references. Original source-template filenames in pickle metadata were replaced with `synthetic-scenario-template`. Workspace references were replaced with `public-scenario` where retained. Numeric measurements and timestamps were not edited. During sanitization, all non-identifier DataFrame columns and ground-truth values were compared with the source; machine names in scoring and the chatbot mapping were retained consistently.

Original deployment links, personal support contacts, Prolific completion/return codes and the client-side tester password were removed. Necessary values are now local environment settings with safe examples. The historical consent text's omitted data-protection contact is identified as such; author names and institutional attribution remain.


## Local configuration changes

- Added an isolated Compose project with PostgreSQL, one-shot seeding, study API, chatbot and frontend/Caddy proxy. Only the proxy is published, on loopback.
- Replaced embedded database defaults with required server configuration. Added dotenv loading for direct execution of the seeder and before chatbot retrieval imports.
- Made the Azure endpoint, key, GPT-4o deployment name and API version configurable. Missing Azure configuration produces a clear unavailable-service response; model-call errors no longer return raw exception details to the browser.
- Retained GPT-4o, the configured temperature, already-English prompts, tasks, assignment method, questionnaires, scoring, timing and study-record logging. Remaining Italian text was subsequently translated as described below. Runtime deployment settings are not statistical-analysis changes.
- Used one local chatbot worker because its conversation registry is process-local; the original deployment command used two. The study API retains two workers.
- Fixed the frontend interface override so an unset value cannot replace a valid assignment with `undefined`. An explicit override remains a development-only mechanism, not server allocation.
- Removed the client-side tester password gate for public local exploration. Enabled artificial participant identities and added a local-copy notice without rewriting the experimental materials.
- Disabled external completion/contact actions by default and made replacement values opt-in, public frontend configuration.
- Added local Vite proxy defaults, optional backup service activation, and Git/Docker exclusions for credentials and newly generated records.
- Explicitly pinned API NumPy to 2.2.6 for the supplied NumPy-2 serialized data. The chatbot's existing NumPy 1.26.4 requirement is retained in its separate service. JavaScript lockfiles are preserved; Python dependencies that were not pinned remain unpinned.

## English-language update

Remaining Italian text (used by developers) has been translated into English. 
The unused language-instruction string in `app/Zero.py` now refers to English instead of Italian. Its existing inactive status is preserved; no additional instruction has been inserted into the active system prompt. Already-English material, variable/function names, API fields, tool names, machine identifiers, author names and institutional attribution are unchanged. No scenario measurements or ground-truth values were changed, and no platform, model or analysis execution was performed for this translation update.

