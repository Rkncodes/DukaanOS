from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.integrations.types import IntegrationNotConfigured


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
    id: str = ""  # the provider's id for this call; the tool's result is sent back under it


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_calls: tuple[ProposedToolCall, ...] = ()  # on an assistant message that asked for tools
    tool_call_id: str | None = None  # on a tool message: which call this is the result of


@dataclass(frozen=True)
class LLMResponse:
    text: str | None = None
    tool_calls: list[ProposedToolCall] = field(default_factory=list)


class LLMError(Exception):
    """The provider could not be reached or answered something unusable. Nothing was answered."""


class LLMProvider(Protocol):
    """The LLM only *proposes* tool calls. It has no database access; proposals are
    validated and executed by app.modules.assistant (tools.execute_tool)."""

    name: str

    def complete(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> LLMResponse: ...


class NotConfiguredLLM:
    name = "none"

    def complete(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> LLMResponse:
        raise IntegrationNotConfigured("No LLM provider configured")
