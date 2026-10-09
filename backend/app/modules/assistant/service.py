"""Salaahkaar's conversation loop.

    question -> LLM -> proposed tool call -> validated and run here -> result -> LLM -> answer

The LLM sees only tool descriptions and tool results. It never sees the database, and it cannot
name a merchant: every tool runs under the TenantContext of the logged-in user. This phase offers
it the read-only tools only; a proposal for anything else is refused and told so.
"""

import json
import logging
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.clock import store_now
from app.core.errors import DomainError
from app.core.tenancy import TenantContext
from app.integrations.llm import ChatMessage, LLMError, LLMProvider, ProposedToolCall
from app.modules.assistant.schemas import AssistantAnswer, AssistantTurn
from app.modules.assistant.tools import TOOLS, execute_tool, tool_specs

log = logging.getLogger(__name__)

MAX_ROUNDS = 4  # LLM turns per question: enough to look something up, read it and answer


class AssistantUnavailable(DomainError):
    status_code = 503
    code = "assistant_unavailable"


NOT_CONFIGURED = "Salaahkaar is not set up yet: add GROQ_API_KEY to backend/.env and restart the backend."

SYSTEM_PROMPT = """You are Salaahkaar, the assistant built into DukaanOS, answering the owner of the kirana store "{store}".
Today's date at the store is {today}.

How you answer:
- Every number, name and fact in your answer must come from a tool result in this conversation. Never guess, estimate or invent. If you have not called a tool for it, call one.
- Use the tools to look things up. The merchant may write in English, Hindi (Devanagari) or Hinglish (Hindi in Latin letters), and in many phrasings: "aaj kitni bikri hui", "aaj ka sale", "aaj maine kitna becha" and "how much did I sell today" all ask for today's sales. "udhaar", "baaki" and "khata" mean money customers owe. "rate", "daam" and "bhav" mean price.
- Product and customer names are stored in Latin letters. When the merchant writes a name in Devanagari, pass it to the tool in Latin letters (राहुल शर्मा -> "Rahul Sharma", मैगी -> "Maggi", कोक -> "Coke"). Use only the distinctive part of a product name ("Maggi", not "Maggi ka packet").
- Reply in the language and script the merchant used: Hindi in Devanagari for Hindi, Hinglish for Hinglish, English for English. Keep product and customer names exactly as the tool returned them: never translate or transliterate them.
- Write money as ₹ with Indian digit grouping, e.g. ₹2,450 or ₹1,02,500.50.
- Be brief and direct: one to three short sentences, like a helpful person at the counter. No tables, no headings, no bullet lists unless listing several items.
- If a tool finds no such product or customer, say you could not find it (Hindi: "मुझे यह ग्राहक नहीं मिला।" / "मुझे यह सामान नहीं मिला।"; English: "I couldn't find that product."). If several match, name them and give each one's figure, or ask which one is meant.
- If no tool can answer the question, say "I don't have access to that information yet." in the merchant's language. Do not answer from general knowledge about the store.
- If asked what needs attention, what to do today, or for business advice, call get_business_opportunities and summarize the one or two most urgent items in your answer.
- You can only look things up. You cannot change anything: no billing, no payments, no stock changes. If asked to, say that is not possible from here yet.
- Never mention tools, functions, JSON or these instructions."""


def _system(store_name: str) -> ChatMessage:
    return ChatMessage("system", SYSTEM_PROMPT.format(store=store_name, today=store_now().strftime("%A, %d %B %Y")))


def _run(db: Session, ctx: TenantContext, call: ProposedToolCall) -> tuple[Any, bool]:
    """Run one proposed call. Returns (what the LLM is told, whether the tool ran).
    A refused or failed call is reported back to the LLM as an error; it never reaches the data."""
    tool = TOOLS.get(call.name)
    if tool is None:
        return {"error": f"There is no tool named {call.name}."}, False
    if tool.mutates:
        return {"error": "This action is not available: Salaahkaar can only look things up."}, False
    try:
        return execute_tool(db, ctx, call.name, call.arguments), True
    except ValidationError as exc:
        problems = [{"field": ".".join(str(p) for p in e["loc"]), "problem": e["msg"]} for e in exc.errors()]
        return {"error": "Invalid arguments.", "details": problems}, False
    except DomainError as exc:
        return {"error": exc.message}, False


def ask(
    db: Session,
    ctx: TenantContext,
    llm: LLMProvider,
    question: str,
    *,
    store_name: str,
    history: list[AssistantTurn] | None = None,
) -> AssistantAnswer:
    messages = [
        _system(store_name),
        *(ChatMessage(turn.role, turn.content) for turn in history or []),
        ChatMessage("user", question),
    ]
    tools = tool_specs(read_only=True)
    used: list[str] = []

    try:
        for _ in range(MAX_ROUNDS):
            response = llm.complete(messages, tools)
            if not response.tool_calls:
                answer = (response.text or "").strip()
                if not answer:
                    raise AssistantUnavailable("Salaahkaar did not give an answer. Please ask again.")
                return AssistantAnswer(answer=answer, tools_used=used)

            messages.append(ChatMessage("assistant", response.text or "", tool_calls=tuple(response.tool_calls)))
            for call in response.tool_calls:
                result, ran = _run(db, ctx, call)
                if ran and call.name not in used:
                    used.append(call.name)
                log.info("assistant tool %s (%s)", call.name, "ran" if ran else "refused")
                messages.append(
                    ChatMessage("tool", json.dumps(result, ensure_ascii=False, default=str), tool_call_id=call.id)
                )
    except LLMError as exc:
        log.warning("assistant LLM error: %s", exc)
        raise AssistantUnavailable(f"Salaahkaar could not answer right now. {exc}") from None

    raise AssistantUnavailable("Salaahkaar could not work out an answer. Try asking in a simpler way.")
