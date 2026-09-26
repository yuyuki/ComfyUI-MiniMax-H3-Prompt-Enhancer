# SPDX-License-Identifier: GPL-3.0-only
"""Same-origin ComfyUI API routes used by the prompt-enhancer frontend."""

from __future__ import annotations

import asyncio

from aiohttp import web
from server import PromptServer

from .prompt_enhancer import discover_models


@PromptServer.instance.routes.post("/minimax_h3_prompt_enhancer/models")
async def minimax_h3_models(request):
    """Proxy model discovery through ComfyUI to avoid browser CORS limitations."""
    try:
        payload = await request.json()
        models = await asyncio.to_thread(
            discover_models,
            payload.get("endpoint", ""),
            payload.get("api_key", ""),
            bool(payload.get("allow_remote_endpoint", False)),
            15,
        )
        return web.json_response({"models": models})
    except Exception as exc:  # ComfyUI route boundary: return a concise UI-safe error.
        return web.json_response({"error": str(exc)}, status=400)


from .planning_diagnostics import explain_diagnostics, preflight  # noqa: E402

_EXPLANATION_LOCK = asyncio.Lock()


@PromptServer.instance.routes.post("/minimax_h3_prompt_enhancer/preflight")
async def minimax_h3_preflight(request):
    """Run the production parsers and planning compiler without invoking an LLM."""
    try:
        payload = await request.json()
        return web.json_response(await asyncio.to_thread(preflight, payload))
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/minimax_h3_prompt_enhancer/explain")
async def minimax_h3_explain(request):
    """Explicit user request only; serialize requests to avoid loading the GPU twice."""
    if _EXPLANATION_LOCK.locked():
        return web.json_response({"error": "An explanation is already running. Please wait."}, status=409)
    try:
        payload = await request.json()
        async with _EXPLANATION_LOCK:
            return web.json_response(await asyncio.to_thread(explain_diagnostics, payload))
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception:
        # Do not return provider bodies, credentials, or traceback contents to the UI.
        return web.json_response({"error": "Cannot obtain an explanation. Check the local endpoint, loaded model, and LM Studio logs."}, status=502)
