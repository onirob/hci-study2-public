import json

ceo = """
1. What was the total cost of energy consumption for the entire plant last quarter?
2. What was the OEE of the entire plant last quarter, and how did it change over time?
3. Did productivity or finished-product quality improve or deteriorate significantly last quarter?
"""

production = """
1. What was the average daily energy consumption of all machines last month?
2. What was the average cycle time of Injection Molding Press 1 last week?
3. What is the OEE of press 2 today?
"""

maintenance = """
1. Which machines have exceeded 75% of their expected service life and may require maintenance?
2. What was the total downtime for each machine last month?
3. Based on historical data, which machines show a high failure rate or require frequent maintenance?
4. What were the main types of maintenance performed during the period under consideration?
"""

quality = """
1. What percentage of the parts produced by each injection molding machine last month were nonconforming?
2. How did product quality change last month compared with the previous month?
3. Is there a relationship between periods of high energy consumption and an increase in nonconforming parts?
"""


other = """
1. What was the average daily energy consumption of all machines last month?
2. What was the total energy consumption last month, and how does it compare with the previous month?
3. How many good parts have we produced so far today?
"""



def question_helper(job_profile = 'other'):
    questions = ""
    base = f"Here are some suggested questions for you: "
    if job_profile == "ceo":
        questions = base + ceo
    elif job_profile == "production_manager":
        questions = base + production
    elif job_profile == "maintenance_manager":
        questions = base + maintenance
    elif job_profile == "quality_manager":
        questions = base + quality
    else:
        questions = base + other


    return json.dumps({"questions": questions, "job_profile": f"The job profile selected by the user is: {job_profile}"})


