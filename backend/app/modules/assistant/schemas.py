from typing import Literal

from pydantic import BaseModel, Field


class AssistantCapability(BaseModel):
    name: str
    description: str
    needs_confirmation: bool  # it changes data, so the merchant will be asked before it runs


class AssistantStatus(BaseModel):
    available: bool  # False: nothing can answer a question
    reason: str | None  # why not, in words the merchant can read
    capabilities: list[AssistantCapability]  # what it can look up today


class AssistantTurn(BaseModel):
    """One earlier message of this conversation, so a follow-up question keeps its meaning."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    history: list[AssistantTurn] = Field(default_factory=list, max_length=12)


class AssistantAnswer(BaseModel):
    answer: str
    tools_used: list[str]  # which of the store's records the answer was read from (tool names)
