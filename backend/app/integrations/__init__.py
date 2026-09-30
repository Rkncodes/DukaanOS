"""Interfaces for external/AI integrations. No providers are chosen yet.

Every integration only *produces structured data* (e.g. RecognizedItem, text,
proposed tool calls). Business effects always happen through module services:

    vision / ocr / speech  ->  RecognizedItem[]  ->  billing.service.add_recognized_items
    llm                    ->  ProposedToolCall  ->  assistant.tools.execute_tool -> services
"""
