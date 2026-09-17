import json
from datetime import datetime
import pandas as pd
from jinja2 import Environment, FileSystemLoader

# Load the Jinja2 template
env = Environment(loader=FileSystemLoader('./assets/'))
kpis_template = env.get_template('kpis_description.jinja2')


def retrieve_maintenances(conn, request_scope, assets_name=None):
    context = {'reading_instructions': False, 'interest_type': "maintenances"}
    kpis_description = kpis_template.render(context)
    
    if assets_name is not None:
        retrieved_data = conn.get_maintenances(assets_name=assets_name)
    else:
        retrieved_data = conn.get_maintenances()
    
    print(f"Retrieved maintenance data: {retrieved_data}")  # Debugging line
    
    retrieved_data_df = pd.DataFrame(retrieved_data)
    return json.dumps({
        "retrieved_data": retrieved_data_df.to_dict(),
        "reading_info": kpis_description
    })