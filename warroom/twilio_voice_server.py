"""
Twilio Voice Server for ClaudeClaw.

Real-time two-way voice calls via Twilio Media Streams + Gemini Live.
Uses the same Gemini Live pipeline as the War Room but with Twilio's
telephone audio format (8kHz mulaw) instead of browser WebSocket audio.

Architecture:
    Phone call → Twilio → Media Streams WebSocket → this server
    → TwilioFrameSerializer (mulaw ↔ PCM) → Gemini Live (speech-to-speech)
    → TwilioFrameSerializer (PCM → mulaw) → Twilio → Phone

Usage:
    warroom/.venv/bin/python warroom/twilio_voice_server.py

Environment variables:
    GOOGLE_API_KEY          Required (Gemini Live)
    TWILIO_ACCOUNT_SID      Required (auto hang-up)
    TWILIO_AUTH_TOKEN        Required (auto hang-up)
    TWILIO_FROM_NUMBER       Required (outbound calls)
    TWILIO_VOICE_PORT        Server port (default: 7861)
    TWILIO_VOICE_VOICE       Gemini voice name (default: "Charon")
    TWILIO_VOICE_MODEL       Gemini model override (optional)
"""

import sys
from pathlib import Path

# Ensure warroom package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

_PROJECT_DIR = str(Path(__file__).resolve().parent.parent)

# Check Python version
if sys.version_info < (3, 10):
    print(f"Error: Python 3.10+ required, got {sys.version}", file=sys.stderr)
    sys.exit(1)

import asyncio
import json
import logging
import os

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    print("Error: python-dotenv not found. Run: pip install -r warroom/requirements.txt", file=sys.stderr)
    sys.exit(1)

try:
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineTask, PipelineParams
    from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.frames.frames import LLMContextFrame
    from pipecat.runner.utils import parse_telephony_websocket, _create_telephony_transport as create_telephony_transport
    from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
except ModuleNotFoundError as e:
    print(f"Error: pipecat-ai dependency not found: {e}", file=sys.stderr)
    sys.exit(1)

try:
    import uvicorn
    from fastapi import FastAPI, WebSocket, Response
    from fastapi.responses import PlainTextResponse
except ModuleNotFoundError as e:
    print(f"Error: fastapi/uvicorn not found: {e}. Run: pip install fastapi uvicorn", file=sys.stderr)
    sys.exit(1)

from config import PROJECT_ROOT, AGENT_VOICES
from personas import get_persona

# Reuse tool handlers from the War Room server
from server import (
    delegate_to_agent_handler,
    get_time_handler,
    list_agents_handler,
    answer_as_agent_handler,
    load_env,
    check_required_keys,
    VALID_AGENTS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("twilio-voice")

# ─── FastAPI app ──────────────────────────────────────────────────────────

app = FastAPI(title="ClaudeClaw Twilio Voice")


@app.post("/twiml")
async def twiml_webhook():
    """Return TwiML that tells Twilio to stream audio to our WebSocket."""
    port = int(os.environ.get("TWILIO_VOICE_PORT", "7861"))
    # The WebSocket URL Twilio connects to. When behind a proxy (dashboard),
    # Twilio's Host header may not match, so we use the same server.
    # The dashboard will proxy /ws/twilio/voice to us, but Twilio can also
    # connect directly if this server is exposed.
    ws_url = f"wss://localhost:{port}/ws"

    # Check if we have an external URL from the environment
    external_url = os.environ.get("TWILIO_WEBHOOK_URL", "")
    if external_url:
        # Convert https:// to wss:// for WebSocket
        ws_url = external_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = f"{ws_url}/twilio-voice/ws"

    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="{ws_url}">
        </Stream>
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


@app.websocket("/ws")
async def twilio_websocket(websocket: WebSocket):
    """Handle Twilio Media Streams WebSocket connection."""
    await websocket.accept()
    logger.info("Twilio Media Streams WebSocket connected")

    try:
        # Parse the telephony handshake (gets stream_sid, call_sid, etc.)
        transport_type, call_data = await parse_telephony_websocket(websocket)
        logger.info("Detected transport: %s, call_id: %s", transport_type, call_data.get("call_id"))

        if transport_type != "twilio":
            logger.error("Expected Twilio transport, got: %s", transport_type)
            await websocket.close()
            return

        # Create the transport with TwilioFrameSerializer
        params = FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
            add_wav_header=False,
        )

        transport = await create_telephony_transport(
            websocket=websocket,
            params=params,
            transport_type=transport_type,
            call_data=call_data,
        )

        # Build the Gemini Live pipeline (same as War Room live mode)
        voice_entry = AGENT_VOICES.get("main", {})
        voice = os.environ.get("TWILIO_VOICE_VOICE", voice_entry.get("gemini_voice", "Charon"))
        model = os.environ.get("TWILIO_VOICE_MODEL")
        system_prompt = get_persona("main", mode="auto")

        # Tool schemas (same as War Room)
        delegate_schema = FunctionSchema(
            name="delegate_to_agent",
            description=(
                "Delegate a unit of work to one of the user's sub-agents. The sub-agent "
                "runs the task asynchronously through its full Claude Code environment "
                "and pings the user on Telegram when finished. Use this for anything that "
                "requires real execution: research, drafting messages, file operations, "
                "scheduling, running code."
            ),
            properties={
                "agent": {
                    "type": "string",
                    "enum": sorted(VALID_AGENTS),
                    "description": "Which sub-agent should handle this work.",
                },
                "title": {
                    "type": "string",
                    "description": "Short 3-8 word label for the task.",
                },
                "prompt": {
                    "type": "string",
                    "description": "Full instructions for the sub-agent.",
                },
                "priority": {
                    "type": "integer",
                    "description": "Task priority 0-10 (default 5).",
                },
            },
            required=["agent", "title", "prompt"],
        )

        get_time_schema = FunctionSchema(
            name="get_time",
            description="Get the current wall clock time.",
            properties={},
            required=[],
        )

        list_agents_schema = FunctionSchema(
            name="list_agents",
            description="List the user's sub-agents with descriptions.",
            properties={},
            required=[],
        )

        answer_schema = FunctionSchema(
            name="answer_as_agent",
            description=(
                "Route the user's question to the best-fit specialist and return their "
                "answer verbatim. Pick the agent whose role matches the question."
            ),
            properties={
                "agent": {
                    "type": "string",
                    "enum": sorted(VALID_AGENTS),
                    "description": "Which specialist should answer.",
                },
                "question": {
                    "type": "string",
                    "description": "The user's full question.",
                },
            },
            required=["agent", "question"],
        )

        tools = ToolsSchema(standard_tools=[
            delegate_schema, get_time_schema, list_agents_schema, answer_schema,
        ])

        context = LLMContext(messages=[], tools=tools)

        # Build Gemini Live service
        live_kwargs = dict(
            api_key=os.environ["GOOGLE_API_KEY"],
            system_instruction=system_prompt,
            inference_on_context_initialization=False,
            settings=GeminiLiveLLMService.Settings(voice=voice),
        )
        if model:
            live_kwargs["model"] = model

        llm = GeminiLiveLLMService(**live_kwargs)
        llm.register_function("delegate_to_agent", delegate_to_agent_handler)
        llm.register_function("get_time", get_time_handler)
        llm.register_function("list_agents", list_agents_handler)
        llm.register_function("answer_as_agent", answer_as_agent_handler)

        aggregators = LLMContextAggregatorPair(context)

        pipeline = Pipeline([
            transport.input(),
            aggregators.user(),
            llm,
            aggregators.assistant(),
            transport.output(),
        ])

        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                allow_interruptions=True,
                enable_metrics=True,
            ),
            idle_timeout_secs=None,
            cancel_on_idle_timeout=False,
        )

        # Push the initial context frame so Gemini accepts audio
        await task.queue_frame(LLMContextFrame(context=context))

        logger.info("Twilio voice pipeline started (voice=%s, model=%s)", voice, model or "default")
        runner = PipelineRunner(handle_sigterm=False)
        await runner.run(task)

    except Exception as e:
        logger.error("Twilio voice pipeline error: %s", e, exc_info=True)
    finally:
        logger.info("Twilio voice call ended")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "twilio-voice"}


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    load_env()
    check_required_keys({
        "GOOGLE_API_KEY": "Google AI (Gemini Live)",
        "TWILIO_ACCOUNT_SID": "Twilio account SID",
        "TWILIO_AUTH_TOKEN": "Twilio auth token",
    })

    port = int(os.environ.get("TWILIO_VOICE_PORT", "7861"))

    # Print ready signal (same format as War Room server for dashboard to parse)
    connection_info = {
        "ws_url": f"ws://localhost:{port}/ws",
        "http_url": f"http://localhost:{port}",
        "status": "ready",
        "transport": "twilio",
    }
    print(json.dumps(connection_info), flush=True)

    logger.info("Twilio Voice Server starting on port %d", port)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
