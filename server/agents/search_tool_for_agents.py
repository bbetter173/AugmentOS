# Beware when updating pydantic to v2, you might need to use pydantic.v1 instead of pydantic namespace
from pydantic import BaseModel, Field
from typing import Any, List, Literal
from bs4 import BeautifulSoup
import requests
from server_config import serper_api_key
from Modules.Summarizer import Summarizer
from langchain.agents.tools import Tool
from helpers.time_function_decorator import time_function


# ban some sites that we can never scrape
banned_sites = ["calendar.google.com", "researchgate.net"]
# custom search tool, we copied the serper integration on langchain but we prefer all the data to be displayed in one json message
k: int = 5
gl: str = "us"
hl: str = "en"
tbs = None
num_sentences = 10
search_type: Literal["news", "search", "places", "images"] = "search"
summarizer = Summarizer(None)


@time_function()
def scrape_page(url: str):
    """
    Based on your observations from the Search_Engine, if you want more details from
    a snippet for a non-PDF page, pass this the page's URL and the page's title to
    scrape the full page and retrieve the full contents of the page.
    """

    print("Parsing: {}".format(url))
    if any(substring in url for substring in banned_sites):
        print("Skipping site: {}".format(url))
        return None
    else:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                'Accept-Charset': 'ISO-8859-1,utf-8;q=0.7,*;q=0.3',
                'Accept-Encoding': 'none',
                'Accept-Language': 'en-US,en;q=0.8',
                'Connection': 'keep-alive',
            }
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()

            soup = BeautifulSoup(response.content, 'html.parser')
            text = " ".join([t.get_text() for t in soup.find_all(
                ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])])
            return text.replace('|', '')
        except requests.RequestException as e:
            print(f"Failed to fetch {url}. Error: {e}")
            return None


@time_function()
def serper_search(
    search_term: str, search_type: str = "search", **kwargs: Any
) -> dict:
    headers = {
        "X-API-KEY": serper_api_key or "",
        "Content-Type": "application/json",
    }
    params = {
        "q": search_term,
        **{key: value for key, value in kwargs.items() if value is not None},
    }
    response = requests.post(
        f"https://google.serper.dev/{search_type}", headers=headers, params=params
    )
    response.raise_for_status()
    search_results = response.json()
    return search_results


@time_function()
def parse_snippets(results: dict) -> List[str]:
    result_key_for_type = {
        "news": "news",
        "places": "places",
        "images": "images",
        "search": "organic",
    }
    snippets = []
    if results.get("answerBox"):
        answer_box = results.get("answerBox", {})
        if answer_box.get("answer"):
            snippets.append(answer_box.get("answer"))
        elif answer_box.get("snippet"):
            snippets.append(answer_box.get("snippet").replace("\n", " "))
        elif answer_box.get("snippetHighlighted"):
            snippets.append(answer_box.get("snippetHighlighted"))

    if results.get("knowledgeGraph"):
        kg = results.get("knowledgeGraph", {})
        title = kg.get("title")
        entity_type = kg.get("type")
        if entity_type:
            snippets.append(f"{title}: {entity_type}.")
        description = kg.get("description")
        if description:
            snippets.append(description)
        for attribute, value in kg.get("attributes", {}).items():
            snippets.append(f"{title} {attribute}: {value}.")

    for result in results[result_key_for_type[search_type]][:k]:
        if "snippet" in result:
            page = scrape_page(result["link"])
            if ('title' not in result) or (result['title'] is None):
                result['title'] = ""
            if page is None:
                snippets.append(
                    f"Title: {result['title']}\nPossible answers: {result['snippet']}\n")
            else:
                summarized_page = summarizer.summarize_description_with_bert(
                    page, num_sentences=num_sentences)
                if len(summarized_page) == 0:
                    summarized_page = "None"
                snippets.append(
                    f"Title: {result['title']}\nSource:{result['link']}\nSnippet: {result['snippet']}\nSummarized Page: {summarized_page}")

    if len(snippets) == 0:
        return ["No good Google Search Result was found"]
    return snippets


@time_function()
def parse_results(results: dict) -> str:
    snippets = parse_snippets(results)
    results_string = ""
    for idx, val in enumerate(snippets):
        results_string += f"<result{idx}>\n{val}\n</result{idx}>\n\n"
    return results_string


@time_function()
def run_search_tool_for_agents(query: str):
    results = serper_search(
        search_term=query,
        gl=gl,
        hl=hl,
        num=k,
        tbs=tbs,
        search_type=search_type,
    )
    return parse_results(results)


@time_function()
async def arun_search_tool_for_agents(query: str):
    results = serper_search(
        search_term=query,
        gl=gl,
        hl=hl,
        num=k,
        tbs=tbs,
        search_type=search_type,
    )
    return parse_results(results)


class SearchInput(BaseModel):
    query: str = Field(description="a search query")


def get_search_tool_for_agents():
    search_tool_for_agents = Tool(
        name="Search_Engine",
        func=run_search_tool_for_agents,
        coroutine=arun_search_tool_for_agents,
        description="Pass this specific targeted queries and/or keywords to quickly search the WWW to retrieve vast amounts of information on virtually any topic, spanning from academic research and navigation to history, entertainment, and current events. It's a tool for understanding, navigating, and engaging with the digital world's vast knowledge.",
        args_schema=SearchInput
    )
    return search_tool_for_agents

from google.cloud import enterpriseknowledgegraph as ekg
from server_config import gcp_project_id
from collections.abc import Sequence

location = 'global'      # Values: 'global'
languages = ['en']                    # Optional: List of ISO 639-1 Codes
types = ['']                          # Optional: List of schema.org types to return
limit = 1                            # Optional: Number of entities to return

# Google knowledge graph search tool
def search_google_knowledge_graph(
    search_query: str,
    project_id: str = gcp_project_id,
    location: str = location, 
    languages: Sequence[str] = languages,
    types: Sequence[str] = None,
    limit: int = limit,):
    
    # Create a client
    client = ekg.EnterpriseKnowledgeGraphServiceAsyncClient()

    # The full resource name of the location
    # e.g. projects/{project_id}/locations/{location}
    parent = client.common_location_path(project=project_id, location=location)

    # Initialize request argument(s)
    request = ekg.SearchPublicKgRequest(
        parent=parent,
        query=search_query,
        languages=languages,
        types=types,
        limit=limit,
    )

    # Make the request
    response = client.search_public_kg(request=request)

    return response

async def asearch_google_knowledge_graph(
    search_query: str,
    project_id: str = gcp_project_id,
    location: str = location, 
    languages: Sequence[str] = languages,
    types: Sequence[str] = None,
    limit: int = limit,):
    
    # Create a client
    client = ekg.EnterpriseKnowledgeGraphServiceAsyncClient()

    # The full resource name of the location
    # e.g. projects/{project_id}/locations/{location}
    parent = client.common_location_path(project=project_id, location=location)

    # Initialize request argument(s)
    request = ekg.SearchPublicKgRequest(
        parent=parent,
        query=search_query,
        languages=languages,
        types=types,
        limit=limit,
    )

    try:
        # Make the request
        response = await client.search_public_kg(request=request)

        # print("response: {}".format(response))
    except:
        print("error in search_google_knowledge_graph")
        response = None
    
    return response

# testing
if __name__ == "__main__":
    print(search_google_knowledge_graph(
        "Poincaré Conjecture"))
