from openai import AsyncAzureOpenAI, AzureOpenAI
from openai import RateLimitError, APIStatusError 

# Functions & Agents
from functions.current_retriever import current_retriever
from functions.historical_retriever import historical_retriever
from functions.retrieve_maintenances import retrieve_maintenances
from functions.question_helper import question_helper
from utils import trim_messages, check_timerange


#utils
import json
from datetime import datetime
import pytz
import re
from jinja2 import Environment, FileSystemLoader
from dotenv import load_dotenv
import os, sys
import time
import logging

# Structured Output
from pydantic import BaseModel, Field, root_validator
from typing import Optional, Union
from enum import Enum
from typing import List

import asyncio  # Import asyncio for sleep

load_dotenv()

from app.scenario_clock import scenario_today_date, scenario_today_str, scenario_time_str

today_date     = scenario_today_date()
today_date_str = scenario_today_str('%Y-%m-%d')
today_time_str = scenario_time_str('%H:%M:%S') 


with open('./assets/app_descr/OverallInfo.txt', 'r') as file:
    info_overall = file.read()

env = Environment(loader=FileSystemLoader('./assets/'))
kpis_template = env.get_template('kpis_description.jinja2')
kpis_description_cur = kpis_template.render(
    {'reading_instructions' : False,
           'interest_type': 'all'
    })
kpis_description_hist = kpis_template.render(
    {'reading_instructions' : False,
           'interest_type': 'historical'
    })

# prefix to be added to the system_message to instruct it about the company and its terminology.
test_prefix = """ 
"""


def _tool_sig(tc) -> tuple:
    return (tc.function.name, tc.function.arguments)

local_timezone = pytz.timezone('Europe/Rome') #pytz.timezone('Europe/Rome')

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def _is_valid_ymd(s: str) -> bool:
    return bool(s) and bool(DATE_RE.fullmatch(s))

def _is_valid_range(rng: list[str]) -> bool:
    if not isinstance(rng, list) or len(rng) != 2:
        return False
    if not (_is_valid_ymd(rng[0]) and _is_valid_ymd(rng[1])):
        return False
    # Optional but cheap sanity check
    try:
        return datetime.fromisoformat(rng[0]) <= datetime.fromisoformat(rng[1])
    except ValueError:
        return False

MAX_RETRIES_429 = 5
SLEEP_SECONDS_429 = 30  

def _is_429(e: Exception) -> bool:
    sc = getattr(e, "status_code", None)
    if sc == 429:
        return True
    s = str(e)
    return ("RateLimitReached" in s) or ("RateLimit" in s) or ("429" in s)

async def _call_with_429_retry(op, *, max_retries=MAX_RETRIES_429):
    for attempt in range(max_retries):
        try:
            return await op()
        except (RateLimitError, APIStatusError) as e:
            if not _is_429(e):
                raise
            if attempt == max_retries - 1:
                raise
            logging.warning("429 rate limit. attempt=%d/%d. sleeping %ds", attempt + 1, max_retries, SLEEP_SECONDS_429)
            await asyncio.sleep(SLEEP_SECONDS_429)

async def _sleep_on_429(e: Exception):
    logging.warning(f"429 rate limit: sleeping {SLEEP_SECONDS_429}s. err={e}")
    await asyncio.sleep(SLEEP_SECONDS_429)


class DateEnum(str, Enum):
    yesterday = "yesterday"
    this_week = "this_week"
    last_week = "last_week"
    this_month = "this_month"
    last_month = "last_month"
    last_trimester = "last_trimester"
    last_semester = "last_semester"
    this_year = "this_year"
    custom_range = "custom"


class TimeGranularityEnum(str, Enum):
    daily = "daily"
    weekly = "weekly"
    monthly = "monthly"
    aggregate = "aggregate"


class CustomRange(BaseModel):
    start_date: str
    end_date: str
    is_one_date: bool


class DateRange(BaseModel):
    #predefined_range: DateEnum = Field('custom', description="Select a proper range, otherwise 'custom'. Periods start always with the first day, for example, weeks start from monday to sunday, months start from day 1 to day 30 or 31.")
    #custom_range: Optional[CustomRange] = Field(None, description="Fill this if predefined_range is set to 'custom'.")
    date_range: CustomRange = Field(None, description="Select a proper range, otherwise 'custom'. Periods start always with the first day, for example, weeks start from monday to sunday, months start from day 1 to day 30 or 31.")
    time_granularity: TimeGranularityEnum = Field(
        TimeGranularityEnum.aggregate,
        description="Select the time granularity for the data. 'daily' retrieves daily data over the range, "
                    "'weekly' retrieves weekly data over the range, 'monthly' retrieves monthly data over the range, "
                    "and 'aggregate' retrieves data aggregated over the entire range. Defaults to 'aggregate'."
    )
class Step(BaseModel):
    explanation: str
    output: DateRange

class DateResponse(BaseModel):
    steps: List[Step]
    final_answer: DateRange

    """ @root_validator(pre=True)
    def validate_exclusive_range(cls, values):
        if not values.get("predefined_range") and not values.get("custom"):
            raise ValueError("Either predefined_range or custom_range must be provided.")
        
        return values """

    class Config:
        use_enum_values = True  # Automatically serialize enums as strings


class Zero:
    def __init__(self, wks: Optional[str] = None):
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip()
        api_key = os.getenv("AZURE_OPENAI_API_KEY", "").strip()
        self.deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o").strip()
        if not endpoint or not api_key or not self.deployment:
            raise ValueError("Missing Azure endpoint, API key, or deployment name")
        self.llm = AsyncAzureOpenAI( 
            azure_endpoint=endpoint,
            api_key=api_key,
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
            timeout=20.0,      # <-- prevents 2-3 min “hang”
            max_retries=0,  
            )
        

        self.assets = [
            'Assembly Machine 1',
            'Assembly Machine 2', 
            'Assembly Machine 3', 
            'Large Capacity Cutting Machine 1', 
            'Large Capacity Cutting Machine 2',
            'Laser Cutter', 
            'Laser Welding Machine 1', 
            'Laser Welding Machine 2',
            'Low Capacity Cutting Machine 1', 
            'Medium Capacity Cutting Machine 1', 
            'Medium Capacity Cutting Machine 2',
            'Medium Capacity Cutting Machine 3',
            'Riveting Machine', 
            'Testing Machine 1',
            'Testing Machine 2',
            'Testing Machine 3', 
            ]
        self.assets_ids = [{'asset_name': 'Testing Machine 3', 'asset_id': 'asset-016'}, {'asset_name': 'Medium Capacity Cutting Machine 3', 'asset_id': 'asset-010'}, {'asset_name': 'Assembly Machine 3', 'asset_id': 'asset-014'}, {'asset_name': 'Laser Welding Machine 2', 'asset_id': 'asset-015'}, {'asset_name': 'Large Capacity Cutting Machine 2', 'asset_id': 'asset-003'}, {'asset_name': 'Low Capacity Cutting Machine 1', 'asset_id': 'asset-009'}, {'asset_name': 'Assembly Machine 2', 'asset_id': 'asset-013'}, {'asset_name': 'Laser Cutter', 'asset_id': 'asset-006'}, {'asset_name': 'Riveting Machine', 'asset_id': 'asset-005'}, {'asset_name': 'Medium Capacity Cutting Machine 2', 'asset_id': 'asset-002'}, {'asset_name': 'Medium Capacity Cutting Machine 1', 'asset_id': 'asset-001'}, {'asset_name': 'Laser Welding Machine 1', 'asset_id': 'asset-012'}, {'asset_name': 'Large Capacity Cutting Machine 1', 'asset_id': 'asset-004'}, {'asset_name': 'Testing Machine 2', 'asset_id': 'asset-008'}, {'asset_name': 'Testing Machine 1', 'asset_id': 'asset-007'}, {'asset_name': 'Assembly Machine 1', 'asset_id': 'asset-011'}]

        self.shifts = [{}]
        self.date_range_cache = []  

    

    def available_assets(self):
        return json.dumps({"available_assets": self.assets})
    
    async def run_conversation(self, messages, streaming=False, job_profile = 'other', company_prefix = "") -> str:
        _language_message = "Reply in English unless another language is requested. If retrieved text is in another language, translate it into the user's language."
        language_message = ""
        system_message = f"""4.Hero, AI assistant for IoT platform monitor historical real-time performances.
        Focus on answering questions to manufacturing facilities, covering topics productivity energy consumption maintenance cost.
        Be informative precise. Avoid speculative inaccurate information. Maintain professional helpful tone responses.
        Ask for clarification if don't know reply. have data at hand, reply citing them explicitly.
        not suggest if not in specific cases.
        Today is {today_date_str+today_time_str}.
        ensure understand recognize implicit date statements if not specified, year nearest to today.
        Ask user to confirm if wants retrieve other data replying question.
        """ + language_message + """
        Here are some additional info about the context of the company:
        """ + company_prefix + "The connected machines are: " + f"{self.assets}." +  "For the text formatting don't use HTML."



        messages = trim_messages(messages)
        self.messages = [ {"role": "system", "content": system_message}]+messages

        #print(self.messages)
        # Step 1: send the conversation and available functions to the model
        tools = [
        {
            "type": "function",
            "function": {
                "name": "current_retriever",
                "description": f"Retrieves realtime data to reply to user's questions about today ({today_date_str+today_time_str}). For example, it replies to questions such as 'Can you tell me if all machines are working now?' or 'How much are we consuming today?'. ",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "request_scope": {
                            "type": "string",
                            "enum": ["single_assets", "overall"],
                            "description": f"The scope of the user's answer. The full description of each scope is the following: {info_overall}"
                        },
                        "interest_type": {
                            "type": "string",
                            "enum": ["time", "energy_and_cost", "production", "efficiency", "status"],
                            "description": f"The type of interest of the user. The full description of each is the following: {kpis_description_cur}"
                        },
                        "assets_name": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": self.assets,
                            },
                            "description": "Only if single_assets is selected. Matching name of the assets. If user asks for more than 2 ask if he/she wants overall data about the factory. If user wants an orderd list such as 'top 3 machines by energy consumption' put all the machines in this list."
                        },
                        "time_granularity": {
                            "type": "string",
                            "enum": ["hourly", "daily"],
                            "description": "Select the appropriate time granularity to respond to the user's request - hourly data on an hourly basis is requested to respond to the user's question, otherwise daily."
                        },
                        "hour_range": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "pattern": "^([01]\\d|2[0-3]):([0-5]\\d)$",
                                "description": "The format is HH:MM."
                            },
                            "minItems": 2,
                            "maxItems": 2,
                            "description": "An array containing exactly two elements: the starting hour and the ending hour. The format is HH:MM. Only if the user wants hourly time granularity and defines a specific range."
                        }
                    },
                    "required": ["request_scope", "interest_type", "time_granularity"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "historical_retriever",
                "description": f"Retrieves all the data except for today ({today_date_str}): e.g., yesterday, this week, and historical data to reply to user's questions about past periods. For example, it replies to questions such as 'How much have we consumed last week?'. Data start from 2025-01-28",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "request_scope": {
                            "type": "string",
                            "enum": ["single_assets", "overall"],
                            "description": f"The scope of the user's answer. The full description of each scope is the following: {info_overall}"
                        },
                        "interest_type": {
                            "type": "string",
                            "enum": ["energy_and_cost", "production", "efficiency"],
                            "description": f"The type of interest of the user. The full description of each is the following: {kpis_description_hist}"
                        },
                        "assets_name": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": self.assets,
                            },
                            "description": "Only if single_assets is selected. Matching name of the assets. If user asks for more than 2 ask if he/she wants overall data about the factory. If user wants an orderd list such as 'top 3 machines by energy consumption' put all the machines in this list."
                        },
                    },
                    "required": ["request_scope", "interest_type"]
                }
            }
        },
        
        
        ]

        '''
        {
            "type": "function",
            "function": {
                "name": "question_helper",
                "description": "Helps the user to formulate helpful questions depending on his job profile.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "request_scope": {
                            "type": "string",
                            "enum": ["single_assets", "overall"],
                            "description": f"The scope of the user's answer. The full description of each scope is the following: {info_overall}"
                        },
                    }
                    },
                }
        },

        {
            "type": "function",
            "function": {
                "name": "retrieve_maintenances",
                "description": f"Retrieves all the maintenance data to reply to user's questions about the maintenance of the factory. For example, it replies to questions such as 'What maintenance has been done on the machines?'",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "request_scope": {
                            "type": "string",
                            "enum": ["single_assets", "overall"],
                            "description": f"The scope of the user's answer. The full description of each scope is the following: {info_overall}"
                        },
                        "assets_name": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": self.assets,
                            },
                            "description": "Only if single_assets is selected. Matching name of the assets. If user asks for more than 2 ask if he/she wants overall data about the factory."
                        },
                    },
                    "required": ["request_scope"]
                }
            }
        },
        '''

        


        #print(tools)   
        try:  
            #Get date ranges
            async def get_date_range():
                print("cache: ", self.date_range_cache)

                time_context = [
                    msg for msg in messages
                    if isinstance(msg, dict) and msg.get('role') in ['user', 'assistant']
                ][:-1]
                print("context: ", time_context)

                user_message = [
                    msg for msg in self.messages
                    if isinstance(msg, dict) and msg.get('role') in ['user']
                ][-1]
                req_messages = time_context + [
                                {"role": "system", "content":
                                    f"Extract specific date ranges from sentences. Dates are in the format YYYY-MM-DD. "
                                    f"Weeks start always with Monday and end with Sunday, consider it when they are across two different months. "
                                    f"Take into account the previous messages for context. Today is {today_date_str}. "
                                    f"Please ensure to understand and recognize implicit date statements: if not specified, the year is always the one nearest to today. "
                                    f"The last mentioned date range was {self.date_range_cache}."
                                },
                                {"role": "user", "content": user_message['content']},
                            ]

                for attempt in range(MAX_RETRIES_429):
                    try:
                        # NOTE: parse() returns a parsed message in choices[0].message.parsed
                        resp = await self.llm.beta.chat.completions.parse(
                            model=self.deployment,
                            temperature=0.5,
                            messages=req_messages,
                            response_format=DateResponse,
                        )
                        return resp.choices[0].message  # has .parsed

                    except (RateLimitError, APIStatusError) as e:
                        if _is_429(e) and attempt < MAX_RETRIES_429 - 1:
                            logging.error("get_date_range 429 error: %s", e, exc_info=True)
                            await _sleep_on_429(e)
                            continue
                        raise  # 429 after retries, or non-429 API error

                    except Exception as e:
                        logging.error("get_date_range failed: %s", e, exc_info=True)
                        return None

                logging.error("get_date_range: max retries reached (429).")
                return None

                
                   
            
            response = await _call_with_429_retry(lambda:  self.llm.chat.completions.create(
                model=self.deployment, # or gpt-35-turbo / gpt-35-turbo-16k 
                messages=self.messages,
                tools=tools,
                tool_choice="auto", #{"type": "function", "function": {"name": "api_retriever"}} 
                #max_tokens=800,
                temperature=0.7,
                parallel_tool_calls=False,
            ))
            response_message = response.choices[0].message



            tool_calls = response_message.tool_calls
            usage = response.usage.dict()
            print(response)

            # Step 2: check if the model wanted to call a function
            if tool_calls:
                
                # Step 3: call the function
                # Note: the JSON response may not always be valid; be sure to handle errors
                available_functions = {
                    "current_retriever": current_retriever,
                    "historical_retriever": historical_retriever,
                    #"retrieve_maintenances": retrieve_maintenances, 
                    "question_helper": question_helper,
                }
                self.messages.append(response_message)  # extend conversation with assistant's reply
                # Step 4: send the info for each function call and function response to the model
                print(self.messages)
                # group duplicates
                groups = {}
                for tc in tool_calls:
                    groups.setdefault(_tool_sig(tc), []).append(tc)

                for (fn_name, fn_args_json), calls in groups.items():
                    tool_call = calls[0]  # execute once

                    print(tool_call)
        
                    function_name = tool_call.function.name
                    function_to_call = available_functions[function_name]
                    
                    function_args = json.loads(tool_call.function.arguments)

                    
                           
                    if function_name == "current_retriever":
                        function_response = function_to_call(
                            request_scope=function_args.get("request_scope"),  
                            interest_type = function_args.get("interest_type"),
                            assets_name=function_args.get("assets_name"),
                            hour_range=function_args.get("hour_range"),
                            time_granularity=function_args.get("time_granularity"),
                        ) + f". These are the latest available realtime data (current time {today_time_str}), so hourly data are until this time and no later data are still available."
                    elif function_name == "historical_retriever":
                        i = 0
                        max_tries = 3
                        date_response = None

                        while True:
                            date_response = await get_date_range()
                            if date_response is not None or i >= max_tries - 1:
                                break
                            i += 1

                        # IMPORTANT: check None first (your old order could crash)
                        if date_response is None or getattr(date_response, "refusal", None):
                            function_response = (
                                f"{getattr(date_response, 'refusal', '')} "
                                "What is the date period you are referring to? "
                                "Example: 'October 2025' or 'from 2025-10-01 to 2025-10-31'."
                            )
                            logging.error(function_response)

                        else:
                            parsed = getattr(date_response, "parsed", None)
                            final = getattr(parsed, "final_answer", None) if parsed else None

                            if final is None or final.date_range is None:
                                function_response = (
                                    "I couldn't infer the date range for this question. "
                                    "Please specify a period (e.g., 'October 2025' or 'from 2025-10-01 to 2025-10-31')."
                                )
                                logging.error(function_response)

                            else:
                                dr = final.date_range
                                candidate_range = (
                                    [dr.start_date, dr.start_date] if dr.is_one_date
                                    else [dr.start_date, dr.end_date]
                                )

                                # ✅ Minimal fix: validate BEFORE calling API and BEFORE updating cache
                                if not _is_valid_range(candidate_range):
                                    function_response = (
                                        "I couldn't determine the time period for this request. "
                                        "Please specify a period (e.g., 'October 2025' or 'from 2025-10-01 to 2025-10-31')."
                                    )
                                    logging.error(f"Invalid extracted range: {candidate_range}")

                                else:
                                    # ✅ Only now update cache
                                    self.date_range_cache = candidate_range
                                    print("cache2: ", self.date_range_cache)

                                    time_granularity = final.time_granularity

                                    function_response = function_to_call(
                                        request_scope=function_args.get("request_scope"),
                                        interest_type=function_args.get("interest_type"),
                                        assets_name=function_args.get("assets_name"),
                                        time_granularity=time_granularity,
                                        custom_range=candidate_range,
                                    ) + f". This data concern the period {candidate_range}. Reply only with the data that answer the user's question."

                    #elif function_name == "retrieve_maintenances":
                    #    function_response = function_to_call(
                    #        request_scope=function_args.get("request_scope"),  
                    #        assets_name=function_args.get("assets_name"),
                    #    )
                    elif function_name == "question_helper":
                        function_response = function_to_call(
                            job_profile=job_profile
                        )
                    
                    
                    logging.info(function_response)    
                    self.messages.append(
                        {
                            "tool_call_id": tool_call.id,
                            "role": "tool",
                            "name": function_name,
                            "content": function_response,
                        },
                    )  
                    print(tool_call)

                #print(function_response)
                # extend conversation with function response
                """ second_response = await self.llm.chat.completions.create(      
                    model=self.deployment, #gpt-4-turbo-preview
                    messages=self.messages,
                    stream=streaming,
                    #max_tokens=2000,
                    temperature=0.6  #Should it be 0 or near 0 when receiving a response from a tool? How does it effect the anaylisis performance?
                )  # get a new response from the model where it can see the function response """

  

                # Retry settings
                max_retries = 5  # Maximum retry attempts
                retry_delay = 30  # Initial wait time in seconds
                attempt = 0

                while attempt < max_retries:
                    try:
                        second_response = await self.llm.chat.completions.create(
                            model=self.deployment,
                            messages=self.messages,
                            stream=streaming,
                            temperature=0.6  
                        )
                        break  # If the request succeeds, break out of the loop

                    except (RateLimitError, APIStatusError) as e:
                        if getattr(e, "status_code", None) in (None, 429) and "429" in str(e):
                            logging.warning(f"Rate limit exceeded: {e}. Retrying in {retry_delay} seconds...")

                        if attempt == max_retries - 1:
                            logging.error("Max retries reached. Unable to proceed due to rate limits.")
                            yield "We are experiencing high usage. Please try again later in 30 seconds."
                            return  # Stop execution

                        await asyncio.sleep(retry_delay)  # Wait before retrying
                        attempt += 1


                response = second_response
                print(self.messages)
                if streaming:
                    async for chunk in response:
                        final_response_message = ''
                        if len(chunk.choices) <= 0:
                            continue
                        content = chunk.choices[0].delta.content
                        if content is not None:
                            final_response_message += content
                            #print(num_tokens(final_response_message))
                            yield content
                else:
                    usage2 = response.usage.dict()
                    tot_usage = {
                        "usage1": usage,
                        "usage2": usage2
                    }
                    yield response.choices[0].message.content#, tot_usage
            else:
                final_response_message = response_message.content
                yield final_response_message#, usage

        except (RateLimitError, APIStatusError) as e:
            if _is_429(e):
                logging.error("Rate limited after retries: %s", e, exc_info=True)
                yield "High usage right now. Please retry in about 30 seconds."
                return
            raise

        except Exception as e:
            logging.error("Error in run_conversation: %s", e, exc_info=True)
            yield "There was an unexpected error, please retry."

   
        


    

