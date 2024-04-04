from typing import Optional

# custom
from agents.agent_utils import format_list_data

# langchain
from langchain.prompts import PromptTemplate
from langchain.schema import (
    HumanMessage
)
from langchain.output_parsers import PydanticOutputParser
from langchain.schema import OutputParserException
from pydantic import BaseModel, Field
from helpers.time_function_decorator import time_function

from Modules.LangchainSetup import *

#pinyin
from pypinyin import pinyin, Style


ll_context_convo_prompt_blueprint = """You are polyglot expert language teacher. You help the language learner by talking to them about their environment.

Target Language: {target_language}
Fluency Level: {fluency_level}

Your job:
Have a simple conversation with the user, in the language they're trying to learn, about the world around them. Do so by considering what the conversation so far, nearby points of interest as conversation topics, and the user's fluency level to moderate the complexity of your outputs. Reponses should be short (5-10 words).

Nearby Points of Interest:
{places}

Examples:
Input 1: 35, Starbucks Coffee, Russian
Output 1: Какой ваш любимый напиток в Starbucks Coffee?
Input 2: 52, [], French
Output 2: Que faites-vous actuellement pour vivre?
Input 3: 61, The British Museum, Chinese
Output 3: 如何询问去大英博物馆内某个展览的路线？

Remember that this is a conversation, your next output should be a continuation of the conversation. Don't repeat things you previously said! Reponses should be short (5-10 words).

Here is the conversation so far (you are the agent) which all the user will ever see:
{conversation_history}

Now provide the (very short) output in {target_language} which continues the above conversation.

Output Format: {format_instructions}"""


@time_function()
def run_ll_context_convo_agent(places: list, target_language: str = "Russian", fluency_level: int = 35, conversation_history: Optional[list[dict[str, str]]] = None):
    # start up GPT3 connection
    llm = get_langchain_gpt35(temperature=0.3)

    places_string = "\n".join(places)

    class ContextConvoAgentQuery(BaseModel):
        """
        Second language learning contextual conversations agent
        """
        response: str = Field(
            description="the next (short, 5-10 words) response to the user in your conversation.")

    ll_context_convo_agent_query_parser = PydanticOutputParser(
        pydantic_object=ContextConvoAgentQuery)

    extract_ll_context_convo_agent_query_prompt = PromptTemplate(
        template=ll_context_convo_prompt_blueprint,
        input_variables=["places",
                         "target_language", "fluency_level", "conversation_history"],
        partial_variables={
            "format_instructions": ll_context_convo_agent_query_parser.get_format_instructions()}
    )

    ll_context_convo_agent_query_prompt_string = extract_ll_context_convo_agent_query_prompt.format_prompt(
        places=places_string,
        target_language=target_language,
        fluency_level=fluency_level,
        conversation_history=conversation_history,
    ).to_string()
    # print(ll_context_convo_agent_query_prompt_string)
    print("LL CONTEXT CONVO PROMPT********************************")
    print(ll_context_convo_agent_query_prompt_string)

    response = llm.invoke(
        [HumanMessage(content=ll_context_convo_agent_query_prompt_string)])
    # print(response)

    try:
        response = ll_context_convo_agent_query_parser.parse(
            response.content).response

        def chinese_to_pinyin(chinese_text):
            return ' '.join([item[0] for item in pinyin(chinese_text, style=Style.TONE)])

        # Apply Pinyin conversion if target_language is "Chinese (Pinyin)"
        if target_language == "Chinese (Pinyin)":
            response = chinese_to_pinyin(response)

        response_obj = dict()
        response_obj["ll_context_convo_response"] = response # pack the response into a dictionary
        response_obj["to_tts"] = {"text": response, "language": target_language}

        print("LL CONTEXT CONVO RESPONSE: ")
        print(response_obj)
        return response_obj

    except OutputParserException as e:
        print('parse fail')
        print(e)
        return None
