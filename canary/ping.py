"""Canary lane: exists only so a claim PR can prove `lane`, `resolve` and `run` all execute."""


def ping() -> str:
    return "pong"

# canary for #30 (lanes web, mcp)
