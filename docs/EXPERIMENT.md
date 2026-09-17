# Experimental flow and implementation map

The [article](../README.md) is the primary source for the study design and findings. This repository supplies the research software and scenario, not participant-level results or statistical analyses. The platform compares a graphical dashboard and an LLM-based conversational interface using the same underlying data and tasks.

## Flow

Consent and eligibility screening are followed by self-reported data literacy and technology familiarity. The server assigns one interface. Familiarization includes interface guidance, questionnaire previews and comprehension/attention checks. Participants then complete T1, T2 and T3 in that fixed order, with NASA-TLX and intended-reliance questions after each task; additional checks and the end screen are also present.

| Task | Decision | Budget | Objective task complexity |
| --- | --- | --- | --- |
| T1 | Identify the day of highest factory energy consumption in May 2025 | 180 seconds | 3 |
| T2 | Rank two cutting machines for automatic power-down, considering September–October idle time and energy use | 360 seconds | 9 |
| T3 | Assign maintenance, process-optimization and quality crews to different machine families using data since October | 600 seconds | 31 |

Exact wording, response constraints, warning/grace phases, attention checks, compensation wording and scoring rules are in the source files below. They have not been rewritten for this release. The public-copy notice and removal/configuration of private access and contact details are release-specific additions.

## Assignment

`hci-study-api/app/services/assignment.py` implements biased-coin minimization. Three literacy strata (cutoffs 5 and 6) combine with three relative-familiarity strata (cutoffs −0.33 and 0.33). The relative-familiarity index is `(dashboard familiarity − chatbot familiarity) / (dashboard familiarity + chatbot familiarity)`.

The imbalance score combines within-stratum and overall arm differences. The lower-imbalance arm is preferred with probability 0.8; ties are randomized. Registration and stored allocation are handled in `app/routes/participants.py`. Local exploration leaves these defaults unchanged. No original participants or allocation counts are imported.

## Shared scenario and clock

Both interfaces retrieve the same seeded machine histories through the study API. The fixed scenario time is **2025-11-05 11:30 Europe/Rome**, equivalent to **10:30 UTC**. The scenario clock does not advance with wall time; session and task timers do.

Clock definitions are retained in the frontend dashboard/familiarization materials, API dashboard cutoff and chatbot utilities, and `hci-study-chatbot-api/app/scenario_clock.py`. 

## Conversational condition

`hci-study-chatbot-api/app/Zero.py` contains the GPT-4o interaction, prompts, tool schemas, machine-name mapping, model calls and response handling. 

The active data-retrieval tools are `functions/current_retriever.py` and `functions/historical_retriever.py`. They resolve machine names through `/api/chatbot/assets/resolve` and query `/api/chatbot/machines/current` or `/api/chatbot/machines/history`. They attach KPI-reading instructions from `assets/kpis_description.jinja2` to the retrieved payload. Inspect `Zero.py` for the exact tools exposed at each model call.

Prompt templates and descriptions are under `assets/`. 

## Source map

| Material or behavior | Location |
| --- | --- |
| Shared task wording and answer options | `hci-study-app/src/data/tasks.ts` |
| Flow order and task budgets | `hci-study-app/src/flow.ts` |
| Session orchestration and local identities | `hci-study-app/src/context/FlowProvider.tsx` |
| Timers and task presentation | `src/context/TimerProvider.tsx`, `src/layouts/StudyLayout.tsx`, `src/components/TaskPanel.tsx` in the frontend |
| Consent, surveys and checks | `hci-study-app/src/pages/` |
| API scoring and timing defaults | `hci-study-api/app/services/surveys_utils.py` |
| Task/survey persistence | `hci-study-api/app/routes/surveys.py` |
| End-of-session bonus rules | `hci-study-api/app/routes/sessions.py` |
| Decision ground truth | `seed_data/decision_ground_truth.csv` |
| Schema and scenario import | `hci-study-api/app/sql/init.sql`, `app/seeders/seed_machines.py` |
| Dashboard retrieval | `hci-study-api/app/routes/dashboard.py` |
| Chatbot retrieval and aggregation | `hci-study-api/app/routes/chatbot.py`, `app/services/chatbot_utils.py` |
| Interaction logging | Frontend `src/telemetry/`, API `app/routes/telemetry.py`, both chatbot services |

