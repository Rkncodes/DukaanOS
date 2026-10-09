from typing import Annotated

from fastapi import Depends

from app.core.config import settings
from app.integrations.groq import GroqLLM
from app.integrations.llm import LLMProvider


def get_llm() -> LLMProvider | None:
    """The LLM behind Salaahkaar, or None when none is configured. The one place a provider is
    chosen: swapping providers (or injecting a fake in tests) happens here and nowhere else."""
    config = settings.groq
    return GroqLLM(config) if config else None


Llm = Annotated[LLMProvider | None, Depends(get_llm)]
