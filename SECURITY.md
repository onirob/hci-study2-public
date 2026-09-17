# Security and participant-data handling

This public folder contains research software and synthetic scenario inputs, not a production recruitment deployment. Keep its entry point bound to localhost and use artificial identities. Do not connect it to the original study database or services.

## Credentials

Keep real `.env` files, Azure keys, database passwords and IP-hashing salts outside Git and Docker image layers. The `.env.example` files contain placeholders only. Generate independent local secrets and supply your own Azure resource if model responses are needed. Every `VITE_*` value is embedded in the frontend and is public.

Sanitizing this copy does not rotate or revoke original credentials. If credentials have previously been exposed, the owner must rotate them at the issuing service. Do not paste secret values into public issues, logs, screenshots or commit messages.

## Newly generated records

Session identity, user-agent information, hashed IP information, task answers, questionnaire responses, click/timing telemetry and chat content can be recorded by the retained platform. Artificial participant IDs do not sanitize free text. Keep the database volume and all backups/analytics exports private, including those made during local exploration.

Git and Docker exclusions block common environment, dump, export, log and data paths. They do not automatically recognize personal data placed in an arbitrary source file, Markdown document or image. Review exactly what will be committed before each later release. Do not force-add ignored records.

Only the supplied `seed_data/*.pkl` and `seed_data/decision_ground_truth.csv` are allowlisted as public data files. Treat changes to this directory as a separate data-release decision. Do not load untrusted pickle files.

## Deployment boundary

Original session authorization and logging behavior are retained for research fidelity. This is not a security-hardened public web service. Before a new recruitment deployment, independently review authentication, access control, TLS, retention, backups, consent text, processor arrangements and data protection requirements. Replace historical contact/payment/recruitment settings under the new study's governance.

External completion and support actions are disabled until explicitly configured. The removed client-side tester password was not a server-side security boundary and should not be recreated as one.

If you discover a potential secret or participant record in a proposed release, stop publication and notify the repository maintainer privately. Do not open a public issue containing the material.
