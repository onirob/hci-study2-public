import os, json
import requests
import pandas as pd
from jinja2 import Environment, FileSystemLoader

# Load the Jinja2 template
env = Environment(loader=FileSystemLoader('./assets/'))
kpis_template = env.get_template('kpis_description.jinja2')

API_BASE = os.getenv("STUDY_API_BASE_URL")  # MUST be absolute (http://...)
if not API_BASE or not API_BASE.startswith("http"):
    raise RuntimeError("STUDY_API_BASE_URL must be set to an absolute URL, e.g. http://api:8787/api")

max_rows = 130

def aggregate_by_kpi(df, overall=False):
    df.set_index('time', inplace=True)

    # Define aggregation functions for each column
    agg_funcs = {
        'sum': 'sum',
        'avg': 'mean',
        'min': 'min',
        'max': 'max',
        'var': 'sum',
        'trend_sum': 'sum',           
        'trend_sum_percentage': 'mean',
        'trend_avg': 'mean',
        'trend_avg_percentage': 'mean'
    }

    # Group by the 'kpi' column and apply the aggregation functions
    if overall:
        kpi_aggregated_df = df.groupby(['kpi']).agg(agg_funcs)
    else: 
        kpi_aggregated_df = df.groupby(['asset_id', 'kpi']).agg(agg_funcs)

    # Rename columns containing "trend" to add "_over_yesterday" at the end
    kpi_aggregated_df.rename(columns=lambda col: col + '_over_yesterday' if 'trend' in col else col, inplace=True)

    # If you want to reset index
    kpi_aggregated_df.reset_index(inplace=True)
    return kpi_aggregated_df

def aggregate_by_hourly_kpi(df):
    df = df.groupby(['kpi', pd.Grouper(key='time', freq='H')]).agg({
                'sum': 'sum',
                'avg': 'mean',
                'min': 'min',
                'max': 'max',
                'var': 'sum',
                'trend_sum': 'sum',          
                'trend_sum_percentage': 'mean',
                'trend_avg': 'mean',
                'trend_avg_percentage': 'mean'
            }).reset_index()
    
    return df

def current_retriever(request_scope, interest_type, assets_name=None, time_granularity='daily', hour_range=None):
    """
    Now delegates to Study API endpoints:
      - /api/chatbot/assets/resolve
      - /api/chatbot/machines/current
    """
    try:
        # 1) Reading info (unchanged)
        context = {'reading_instructions': False, 'interest_type': interest_type}
        kpis_description = kpis_template.render(context)
        warnings = []

        # 2) Resolve assets → machine_ids (only if single_assets)
        machine_ids = None
        resolved_assets = None
        if request_scope == 'single_assets':
            if not assets_name or len(assets_name) == 0:
                return json.dumps({"error": "assets_name is required for single_assets"})
            # resolve by names (exact-insensitive on name or meta.aliases)
            res = requests.get(f"{API_BASE}/chatbot/assets/resolve", params=[("q", a) for a in assets_name])
            res.raise_for_status()
            data = res.json()
            matches = data.get("matches", [])
            # keep first match per asset input name (simple policy; refine if needed)
            if not matches:
                return json.dumps({"error": "No matching assets found."})
            # In case the user passes 2+ names, we accept all matches
            machine_ids = [m["machine_id"] for m in matches]
            resolved_assets = {m["machine_id"]: m for m in matches}

        time_granularity = time_granularity or 'hourly'
        # 3) Call machines/current
        params = {
            "request_scope": request_scope,
            "interest_type": interest_type,
            "time_granularity": time_granularity,
            "window": "since_midnight",  # default per agreement
            "tz": "Europe/Rome",
        }
        if hour_range and time_granularity == "hourly":
            params["hour_range"] = ",".join(hour_range)

        if machine_ids:
            for mid in machine_ids:
                params.setdefault("machine_id", []).append(mid)

        res = requests.get(f"{API_BASE}/chatbot/machines/current", params=params)
        res.raise_for_status()
        api_payload = res.json()

        # 4) Build the final payload for the LLM (keep your shape / fields)
        # You can either pass-through api_payload or keep some of your post-processing.
        # Here we pass-through and attach reading_info + warnings.
        result = {
            "retrieved_data": api_payload,
            "time_granularity": time_granularity,
            "timerange": hour_range if time_granularity == 'hourly' else "today",
            "considered_assets": assets_name,
            "reading_info": kpis_description,
            "warnings": warnings + api_payload.get("notes", []),
        }
        return json.dumps(result)

    except requests.HTTPError as http_err:
        return json.dumps({"error": f"API error: {str(http_err)}", "details": getattr(http_err, 'response', None).text if hasattr(http_err, 'response') and http_err.response is not None else None})
    except Exception as e:
        return json.dumps({"error": f"It wasn't possible to retrieve the requested information. {str(e)}"})
