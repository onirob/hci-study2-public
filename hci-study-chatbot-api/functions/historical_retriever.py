# functions/historical_retriever.py
import os, json
from jinja2 import Environment, FileSystemLoader
import requests

# Jinja for reading instructions
env = Environment(loader=FileSystemLoader('./assets/'))
kpis_template = env.get_template('kpis_description.jinja2')

API_BASE = os.getenv("STUDY_API_BASE_URL")  # MUST be absolute (http://...)
if not API_BASE or not API_BASE.startswith("http"):
    raise RuntimeError("STUDY_API_BASE_URL must be set to an absolute URL, e.g. http://api:8787/api")

def historical_retriever(
    request_scope,
    interest_type,
    assets_name,
    timerange="custom",
    time_granularity="aggregate",
    custom_range=None
):
    """
    Delegates historical requests to Study API:
    GET /api/chatbot/machines/history
    """
    try:
        # 1) reading info (same as before, but with reading_instructions=True)
        context = {'reading_instructions': True, 'interest_type': interest_type}
        kpis_description = kpis_template.render(context)

        # 2) resolve asset names -> ids if single_assets
        machine_ids = None
        if request_scope == "single_assets":
            if not assets_name:
                return json.dumps({"error": "assets_name is required for single_assets"})
            res = requests.get(f"{API_BASE}/chatbot/assets/resolve", params=[("q", a) for a in assets_name])
            res.raise_for_status()
            matches = res.json().get("matches", [])
            if not matches:
                return json.dumps({"error": "No matching assets found."})
            machine_ids = [m["machine_id"] for m in matches]

        # 3) build query
        params = {
            "request_scope": request_scope,
            "interest_type": interest_type,
            "time_granularity": time_granularity,
            "timerange": timerange,
            "tz": "Europe/Rome",
        }
        if timerange == "custom":
            if not custom_range or len(custom_range) != 2:
                return json.dumps({"error": "custom_range must be ['YYYY-MM-DD','YYYY-MM-DD'] when timerange='custom'."})
            params["custom_start"], params["custom_end"] = custom_range[0], custom_range[1]

        if machine_ids:
            for mid in machine_ids:
                params.setdefault("machine_id", []).append(mid)

        # 4) call API
        res = requests.get(f"{API_BASE}/chatbot/machines/history", params=params)
        res.raise_for_status()
        payload = res.json()

        # 5) shape final result for the LLM
        result = {
            "retrieved_data": payload,           # structured JSON (aggregate or series)
            "time_granularity": time_granularity,
            "timerange": custom_range if timerange == "custom" else timerange,
            "considered_assets": assets_name,
            "reading_info": kpis_description,
            "warnings": payload.get("notes", []),
        }
        return json.dumps(result)

    except requests.HTTPError as http_err:
        return json.dumps({"error": f"API error: {str(http_err)}",
                           "details": getattr(http_err, 'response', None).text if hasattr(http_err, 'response') and http_err.response is not None else None})
    except Exception as e:
        return json.dumps({"error": f"It wasn't possible to retrieve the requested information. {str(e)}"})
