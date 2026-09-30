from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.integrations.types import IntegrationNotConfigured


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str


@dataclass(frozen=True)
class ToolSpec:
    """What the LLM is told about a tool (built from assistant.tools registry)."""

    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class ProposedToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class LLMResponse:
    text: str | None = None
    tool_calls: list[ProposedToolCall] = field(default_factory=list)


class LLMProvider(Protocol):
    """The LLM only *proposes* tool calls. It has no database access; proposals are
    validated and executed by app.modules.assistant.tools.execute_tool."""

    def complete(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> LLMResponse: ...


class NotConfiguredLLM:
    def complete(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> LLMResponse:
        raise IntegrationNotConfigured("No LLM provider configured")
