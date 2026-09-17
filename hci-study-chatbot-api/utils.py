from datetime import datetime, timedelta
import pandas as pd
from pandas import json_normalize
import json
import numpy as np
import os
import os.path
from enum import Enum
import pickle
import tiktoken
import logging

ulogger = logging.getLogger(__name__)


### Keep message history within the context budget. ###
encoding = tiktoken.get_encoding('cl100k_base')
def num_tokens_from_string(string: str) -> int:
    """Returns the number of tokens in a text string."""
    num_tokens = len(encoding.encode(string))
    return num_tokens

def count_messages_token(messages):
    final_count = 0
    for message in messages:
        final_count += num_tokens_from_string(message['content'])
    return final_count


def trim_messages(messages, max_tokens=60000): # The original implementation reserves a 60k message budget within GPT-4o's 128k context window.
    while count_messages_token(messages) > max_tokens and messages:
        messages.pop(0)
    return messages
##############################################################################

#this function can be called to filter out all the timestamps in the json response, useful to reduce prompt length.
def filter_out_timestamps(data):
    if isinstance(data, dict):
        return {key: filter_out_timestamps(value) for key, value in data.items() if key != 'daily_hours'}
    elif isinstance(data, list):
        for item in data:
            item.pop('devices', None)
            item.pop('created_at', None)
        return data
    else:
        return data
    
def filter_kpis(df, interest):
    kpi_list = []
    if interest == "time":
        kpi_list = ['working_time', 'idle_time', 'offline_time', 'disconnected_time', 'alarm_time']
    elif interest == "energy_and_cost":
        kpi_list = ['consumption', 'power', 'cost', 'consumption_working', 'consumption_idle']
    elif interest == "production":
        kpi_list = ['cycles', 'good_cycles', 'bad_cycles', 'average_cycle_time', 'average_cycle_cost']
    elif interest == "efficiency":
        kpi_list = ['availability', 'performance', 'quality', 'oee']
    else:
        return df  # Return original dataframe if interest is not recognized

    # Filter the dataframe using boolean indexing
    filtered_df = df[df['kpi'].isin(kpi_list)].copy()
    
    return filtered_df


def filter_period(data, selected_period):
    if selected_period != "day":
        # Define a list of periods to keep
        periods_to_keep = [selected_period] # others could be selected in the future...
    else:
        periods_to_keep = ["day"]
    if isinstance(data, dict):
        # Iterate over the keys of the JSON object
        for kpi_name, kpi_data in data['kpi'].items():
            if kpi_data is not None:
                # Ensure kpi_data is not None before accessing its keys
                for period in list(kpi_data.keys()):
                    if period not in periods_to_keep:
                        # Remove the data for this period
                        del data['kpi'][kpi_name][period]
    return data

def round_json_values(data, precision=2):
    if isinstance(data, dict):
        return {k: round_json_values(v, precision) for k, v in data.items()}
    elif isinstance(data, list):
        return [round_json_values(item, precision) for item in data]
    elif isinstance(data, (int, float)):
        return round(data, precision)
    else:
        return data

def seconds_to_hhmm(seconds):
    if pd.isnull(seconds) or seconds is None:
        return None
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    return f'{hours:02d} hours, {minutes:02d} minutes'

def seconds_to_time(seconds):
    # Calculate hours, minutes, and seconds
    hours = seconds // 3600
    seconds %= 3600
    minutes = seconds // 60
    seconds %= 60

    # Create a timedelta object with the calculated values
    delta = timedelta(hours=hours, minutes=minutes, seconds=seconds)

    # Create a datetime object for 00:00:00 (midnight)
    midnight = datetime.strptime("00:00:00", "%H:%M:%S")

    # Add the timedelta to midnight to get the desired time
    desired_time = midnight + delta

    # Format the time as 'hour:minute:second'
    return desired_time.strftime("%H:%M:%S")

# for shifts
def seconds_to_hhmm(seconds):
    """Convert seconds since midnight to HH:MM format."""
    return str(timedelta(seconds=seconds))[:-3]

def convert_shifts_to_hhmm(shifts):
    """Convert all shift times to HH:MM format for each day and simplify the dictionary."""
    simplified_shifts = []
    for shift in shifts:
        simplified_shift = {'name': shift['name']}
        for day in ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']:
            simplified_shift[day] = [
                {'start': seconds_to_hhmm(time['start']), 'end': seconds_to_hhmm(time['end'])}
                for time in shift[day]
            ]
        simplified_shifts.append(simplified_shift)
    return simplified_shifts


def round_df_values(df):
    # Define a regex pattern to match column names using non-capturing groups
    pattern = r'(?:sum|avg|min|max|var|trend_sum|trend_sum_percentage|trend_avg|trend_avg_percentage)'

    # Identify numerical columns that match the pattern and exist in the DataFrame
    numerical_cols = df.columns[df.columns.str.contains(pattern, regex=True)]

    # Convert identified columns to numeric (coerce errors to NaN) and round them
    df[numerical_cols] = df[numerical_cols].apply(pd.to_numeric, errors='coerce').round(2)

    # Replace NaN values with None for identified columns
    df[numerical_cols] = df[numerical_cols].astype(object).where(pd.notnull(df[numerical_cols]), None)

    return df

def process_time_kpis(df):
    
    # Define a regex pattern to match relevant column names using non-capturing groups
    pattern = r'^(sum|avg|min|max|trend_sum)(?!_percentage)'
    
    # Identify numerical columns that match the pattern and exist in the DataFrame
    numerical_cols = df.columns[df.columns.str.contains(pattern, regex=True)]
    
    # List of time KPIs to filter
    time_kpis = ['working_time', 'idle_time', 'offline_time', 'disconnected_time']
    
    # Filter rows where 'kpi' column is in time_kpis
    kpi_filter = df['kpi'].isin(time_kpis)
    
    # Apply the seconds_to_hhmm function to the identified columns
    df.loc[kpi_filter, numerical_cols] = df.loc[kpi_filter, numerical_cols].applymap(
        lambda x: seconds_to_hhmm(x) if pd.notnull(x) else None
    )

    return df

def process_energy_kpis(df):
    energy_kpis = ['consumption', 'power', 'consumption_working', 'consumption_idle']
    for col in ['sum', 'avg', 'min', 'max', 'trend_sum']:
        kpi_filter = df['kpi'].isin(energy_kpis)
        df.loc[kpi_filter, col] = df.loc[kpi_filter, col].apply(lambda x: convert_to_kw(x) if pd.notnull(x) else None)
    return df

def convert_to_kw(value):
    # Assuming the value is in watts or watt-hours, convert to kilowatts or kilowatt-hours
    return value / 1000

def process_productivity_kpis(df):
    productivity_kpis = ['oee', 'quality', 'performance', 'availability']
    for col in ['sum', 'avg', 'min', 'max', 'trend_sum']:
        kpi_filter = df['kpi'].isin(productivity_kpis)
        df.loc[kpi_filter, col] = df.loc[kpi_filter, col].apply(lambda x: convert_to_perc(x) if pd.notnull(x) else None)
    return df

def convert_to_perc(value):
    # Convert from decimals to whole percentage numbers: 0.10 -> 10
    return value * 100





################################

################################
### used for info of all machines in current_retriever ###
def process_overall_info(assets_data):
    try:
        df = pd.DataFrame(assets_data)
        # Normalize the nested structure of the kpi column
        df_normalized = pd.concat([df.drop(columns=['kpi']), json_normalize(df['kpi'])], axis=1)

        def custom_aggregation(df):
            agg_dict = {}
            for column in df.columns:
                if column.endswith('sum'):
                    agg_dict[column] = df[column].sum()
                elif column.endswith('avg') or column.endswith('percentage'):
                    agg_dict[column] = df[column].mean()
                elif column.endswith('min'):
                    agg_dict[column] = df[column].min()
                elif column.endswith('max'):
                    agg_dict[column] = df[column].max()  # Use max() for 'max' column
                else:
                    # For other statistics like min, max, var, etc., you can define appropriate aggregation logic
                    pass
            return pd.Series(agg_dict)

        # Apply custom aggregation function to the entire DataFrame
        aggregated_df = custom_aggregation(df_normalized)
        # Function to convert flattened DataFrame to nested JSON
        def convert_to_nested_json(df_json):
            nested_dict = {}
            df_dict = json.loads(df_json)
            for column, value in df_dict.items():
                keys = column.split('.')
                temp_dict = nested_dict
                for key in keys[:-1]:
                    if key not in temp_dict:
                        temp_dict[key] = {}
                    temp_dict = temp_dict[key]
                temp_dict[keys[-1]] = value  # Use value from parsed JSON
            return nested_dict

        # Convert DataFrame to JSON string
        aggregated_json = aggregated_df.to_json()

        # Convert JSON string to nested JSON
        nested_json = convert_to_nested_json(aggregated_json)
    except Exception as e:
            print(f"Unexpected error: {e}")
            return "There was an error processing the data"
    
    return nested_json



# could be used to return the retrieved data together with the llm response
def json_to_text(json_data):
    try:
        # Parse JSON data
        data = json.loads(json_data)
        
        # List to store text
        text_list = []
        
        # Iterate through JSON object
        for item in data:
            # Check if item is a string
            if isinstance(data[item], str):
                text_list.append(data[item])
            # If item is a nested dictionary, iterate through it
            elif isinstance(data[item], dict):
                for nested_item in data[item]:
                    if isinstance(data[item][nested_item], str):
                        text_list.append(data[item][nested_item])
                    else:
                        # If nested item is not a string, you can handle it as needed
                        pass
            else:
                # If item is not a string or nested dictionary, you can handle it as needed
                pass
        
        return text_list
    
    except json.JSONDecodeError as e:
        print("Error decoding JSON:", e)
        return []





#####################

def load_dataframes(overall:bool, folder_path = './assets/historical_data/' ):
    """ Returns a dictionary with 4 dataframes: alarms, consumption, productivity, states"""
    dfs = []
    if overall == True:
        file_name = 'overall_dfs.pkl'
    else:
        file_name = 'assets_dfs.pkl'
    file_path = os.path.join(folder_path, file_name)
    with open(file_path, 'rb') as f:
        dfs = pickle.load(f)
########### code needed to process csv #############
    #for file_name in os.listdir(folder_path):
    #    if file_name.endswith("csv"):
    #        file_path = os.path.join(folder_path, file_name)
    #        current_df = pd.read_csv(file_path)
    #        current_df['ts'] = pd.to_datetime(current_df['ts'])
    #        current_df.sort_values(by='ts', inplace=True)
    #        current_df.set_index('ts', inplace=True)

    #        category = file_name.split(".")[0]  # Extract category from file name
    #        if category in dfs:  # Only process if category is in the dictionary keys
    #            if dfs[category] is None:
    #                dfs[category] = process_data(current_df, csv_type=CsvType[category.upper()], overall=overall) 
    return dfs



############ code needed to process csv #############
class CsvType(Enum):
    ALARMS = 1
    CONSUMPTION = 2
    PRODUCTIVITY = 3
    STATES = 4

def process_data(df, csv_type, overall:bool):
        columns_agg = {}
        columns_rename = {}
        if csv_type == CsvType.ALARMS:
            print("Processing alarms data")
            # "asset_id","name","ts","alarm","active","asset_type"
            df.drop(columns=['name', 'asset_type', 'alarm'], inplace=True)
            df.dropna(subset=['active'], inplace=True)
            df = compute_alarm_time(df)
            columns_agg = {'alarm_duration': ['sum', 'mean', 'std'], 'active': ['sum']}
            columns_rename = {'alarm_duration': 'Alarm Duration (s)', 'active' : 'Alarms (#)'}
        elif csv_type == CsvType.CONSUMPTION:
            print("Processing consumption data")
            #"workspace_id","asset_id","consumption","power_avg","cost","consumption_idle","consumption_working","ts","input_line_index","output_line_index","voltage_in_avg","voltage_in_min","voltage_in_max","current_in_avg","current_in_min","current_in_max","total_harmonic_distortion_avg","total_harmonic_distortion_min","total_harmonic_distortion_max","reactive_power_avg","reactive_power_min","reactive_power_max","apparent_power_avg","apparent_power_min","apparent_power_max","power_factor_avg","power_factor_min","power_factor_max","current_unbalance_avg","current_unbalance_min","current_unbalance_max","power_min","power_max","consumption_disconnected","consumption_low","consumption_medium","consumption_high","consumption_critical"
            columns_to_keep = df.columns[:df.columns.get_loc('input_line_index')]
            columns_to_keep = [col for col in columns_to_keep if col not in ['workspace_id', 'asset_type']]
            df = df[columns_to_keep]
            columns_agg = {'consumption': ['sum', 'mean', 'std'], 'power_avg': ['sum', 'mean', 'std'], 'cost': ['sum', 'mean', 'std'], 'consumption_idle': ['sum', 'mean', 'std'], 'consumption_working': ['sum', 'mean', 'std']}
            columns_rename = {'consumption': 'Consumption (kWh)', 'power_avg': 'Power (kW)', 'cost': 'Cost (€/kWh)', 'consumption_idle' : 'Consumption in Idle State (kWh)', 'consumption_working' : 'Consumption in Working State (kWh)'}
        elif csv_type == CsvType.PRODUCTIVITY:
            #"workspace_id","asset_id","ts","good","bad","act","quality","performance","availability","oee","planned_production_time","run_time","net_run_time","fully_productive_time","code","ict"
            print("Processing productivity data")
            df.drop(columns=['workspace_id', 'code'], inplace=True)
            columns_agg = {'good': ['sum', 'mean', 'std'], 'bad': ['sum', 'mean', 'std'], 'act': ['mean', 'std'], 'quality': [mean, std], 'performance': [mean, std], 'availability': [mean, std], 'oee': [mean, std], 'planned_production_time': ['sum', 'mean', 'std'], 'run_time': ['sum', 'mean', 'std'],  'net_run_time': ['sum', 'mean', 'std'], 'fully_productive_time': ['sum', 'mean', 'std'], 'ict': ['mean', 'std']}
            columns_rename = {'good': 'Good pieces (#)', 'bad': 'Bad pieces (#)', 'act' : 'Actual Cicle Time (s)', 'quality' : 'Quality (%)', 'performance' : 'Performance (%)', 'availability' : 'Availability (%)', 'oee': 'Overall Equipment Efficiency (%)', 'planned_production_time' : 'Planned Production TIme (s)', 'run_time' : 'Run Time (s)', 'net_run_time' : 'Net Run Time (s)', 'fully_productive_time' : 'Fully Productive Time (s)', 'ict' : 'Ideal Cicly Time (s)'}
        elif csv_type == CsvType.STATES:
            print("Processing states data")
            #"workspace_id","asset_id","ts","state","input_line_index","output_line_index"
            df.drop(columns=['workspace_id', 'input_line_index', 'output_line_index'], inplace=True)
            columns_agg = {'state' : [count_working, count_idle]}
            columns_rename = {'state': 'State'}
        else:
            print("Invalid case")
        # Concatenate all DataFrames into a single DataFrame
        #combined_df = pd.concat(dfs)
        df.reset_index(inplace=True)  # Reset index to handle overall=True case
        
        if overall:
            df = df.resample('W-MON', on='ts').agg(columns_agg)
        else:
            df = df.groupby(['asset_id', pd.Grouper(key='ts', freq='W-MON')]).agg(columns_agg)


        #df = add_trends(df)
        df = df.rename(columns=columns_rename)
        df = df.round(2)
        df.reset_index(inplace=True)  # Reset the index to access date attribute
        df['week_start'] = df['ts'].dt.date  # Extract the date
        df.set_index('week_start', inplace=True)  # Set date as index
        df.drop(columns=['ts'], level=0, inplace=True)
        df.index.rename("week_start", inplace=True)

        return df.sort_index()

def add_trends(df):
        for level_0 in df.columns.levels[0]:
            std_index = df.columns.get_loc((level_0, 'std'))
            if std_index != -1:
                trend_col_level_0 = level_0
                trend_col_level_1 = 'trend %'
                # Insert trend column after the current std column
                df.insert(std_index + 1, (trend_col_level_0, trend_col_level_1), None)
                # Calculate trend for the newly added column
                if level_0 == 'oee':
                    trend_value = ((df[level_0]['mean'] - df[level_0]['mean'].shift(1)) / df[level_0]['mean'].shift(1)).round(2)
                else:
                    trend_value = (((df[level_0]['sum'] - df[level_0]['sum'].shift(1)) / df[level_0]['sum'].shift(1)) * 100).round(2)
                # Replace 'inf' with "Increase from 0"
                trend_value = trend_value.replace([np.inf, -np.inf], 0)
                #trend_value = trend_value.replace([np.inf, -np.inf], "Increase from 0")
                trend_value.iloc[0] = 0
                #trend_value.iloc[0] = 'first period'
                df[(trend_col_level_0, trend_col_level_1)] = trend_value
        return df
    
    # Define a custom function for calculating the mean and std for percentages
def mean(x):
        return x.mean() * 100
    
def std(x):
        return x.std() * 100

def count_working(x):
    return (x == 'working').sum()
def count_idle(x):
    return (x == 'idle').sum()

def compute_alarm_time(df):
    # Find the start and end of each alarm per asset_id
    alarm_start_end = {}
    alarm_start = None
    for index, row in df.iterrows():
        asset_id = row['asset_id']
        if row['active'] and alarm_start is None:
            alarm_start = index
        elif not row['active'] and alarm_start is not None:
            if asset_id not in alarm_start_end:
                alarm_start_end[asset_id] = []
            alarm_end = index
            alarm_start_end[asset_id].append((alarm_start, alarm_end))
            alarm_start = None

    # Calculate duration of alarms per asset_id and normalize timestamps by hour
    hourly_duration_dfs = []
    for asset_id, start_end_list in alarm_start_end.items():
        durations = []
        for start, end in start_end_list:
            duration = (end - start).total_seconds()
            start_hour = start.floor('H')
            durations.append((start_hour, duration, True))
        if durations:
            df_asset = pd.DataFrame(durations, columns=['ts', 'alarm_duration', 'active'])
            df_asset['asset_id'] = asset_id
            hourly_duration_dfs.append(df_asset)

    # Concatenate DataFrames for all asset_ids into a single DataFrame
    combined_df = pd.concat(hourly_duration_dfs, ignore_index=True)
    return combined_df

def check_timerange(timerange):
    """
    Sometimes the LLM selects the wrong year when it's implicitly stated by the user: 
    e.g., January said in February 2024 means January 2024, but the LLM can choose 2023 leading to a situation of no data retrieved.
    This function replaces the year with the current one in those situations.
    """
    try:
        current_date = datetime.strptime("2024-02-27", "%Y-%m-%d")
        threshold_date = datetime.strptime("2023-11-01", "%Y-%m-%d")
        
        start_date = datetime.strptime(timerange[0], "%Y-%m-%d")
        end_date = datetime.strptime(timerange[1], "%Y-%m-%d")
        
        # Check if the start date is before the threshold date
        if start_date < threshold_date:
            # Calculate the difference in years between current_date and threshold_date
            year_diff = current_date.year - threshold_date.year
            
            # Modify both start and end dates by adding the year difference
            start_date = start_date.replace(year=start_date.year + year_diff)
            end_date = end_date.replace(year=end_date.year + year_diff)
        
        if start_date > current_date:
            # If the start date is after the current date after the check, the user meant to retrieve data before the threshold date, so raise an error
            raise ValueError("The provided time range falls before the threshold date.")
        
        return [start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d")]
    
    except ValueError as e:
        # If an error occurs, return a fixed time range
        fixed_timerange = ["2024-01-01", "2024-01-31"]
        print("Error:", e)
        return fixed_timerange


