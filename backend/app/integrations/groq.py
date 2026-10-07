"""Groq, through its OpenAI-compatible Chat Completions API, with native function calling.

Only DukaanOS's own tools are ever offered to the model: none of Groq's built-in tools (web
search, code execution) are requested. The API key stays in this module: it is sent to Groq in
the Authorization header and appears nowhere else (not in errors, not in logs, not in repr).
"""

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.integrations.llm import ChatMessage, LLMError, LLMResponse, ProposedToolCall, ToolSpec

BASE_URL = "https://api.groq.com/openai/v1"


@dataclass(frozen=True)
class GroqConfig:
    api_key: str = field(repr=False)
    model: str = "openai/gpt-oss-120b"
    timeout_seconds: float = 30
    base_url: str = BASE_URL


def _message(message: ChatMessage) -> dict[str, Any]:
    if message.role == "tool":
        return {"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content}
    body: dict[str, Any] = {"role": message.role, "content": message.content}
    if message.tool_calls:
        body["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": json.dumps(call.arguments, ensure_ascii=False)},
            }
            for call in message.tool_calls
        ]
    return body


def _arguments(raw: Any) -> dict[str, Any]:
    """The model sends arguments as a JSON string. Anything else becomes no arguments, which the
    tool's own validation then judges."""
    try:
        parsed = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class GroqLLM:
    name = "groq"

    def __init__(self, config: GroqConfig, transport: httpx.BaseTransport | None = None):
        self._config = config
        self._transport = transport  # tests pass a mock transport; nothing else does

    @property
    def model(self) -> str:
        return self._config.model

    def complete(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> LLMResponse:
        payload: dict[str, Any] = {
            "model": self._config.model,
            "messages": [_message(m) for m in messages],
            "temperature": 0.2,
        }
        if tools:
            payload["tools"] = [
                {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}
                for t in tools
            ]
            payload["tool_choice"] = "auto"

        try:
            with httpx.Client(timeout=self._config.timeout_seconds, transport=self._transport) as client:
                response = client.post(
                    f"{self._config.base_url}/chat/completions",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._config.api_key}"},
                )
        except httpx.HTTPError as exc:
            # The exception's own text can quote the request; only its kind is passed on.
            raise LLMError(f"Groq could not be reached ({type(exc).__name__})") from None

        if response.status_code in (401, 403):
            raise LLMError("Groq rejected the API key. Check GROQ_API_KEY.")
        if response.status_code == 429:
            raise LLMError("Groq's rate limit was reached. Try again in a moment.")
        if response.status_code != 200:
            raise LLMError(f"Groq answered with an error ({response.status_code}): {_error_text(response)}")

        try:
            message = response.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise LLMError("Groq's answer could not be read") from None

        calls = [
            ProposedToolCall(
                id=str(call.get("id") or ""),
                name=str((call.get("function") or {}).get("name") or ""),
                arguments=_arguments((call.get("function") or {}).get("arguments")),
            )
            for call in message.get("tool_calls") or []
        ]
        return LLMResponse(text=message.get("content"), tool_calls=calls)


def _error_text(response: httpx.Response) -> str:
    try:
        return str(response.json()["error"]["message"])[:300]
    except (ValueError, KeyError, TypeError):
        return "no details"
