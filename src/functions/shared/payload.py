"""Run-hook payload construction.

Builds the per-session dispatch blob delivered to the MicroVM via runHookPayload
(the request body of the /run lifecycle hook). Contains only non-secret data:
session id, environment id, region, and a *reference* to the Secrets Manager
secret holding the environment key. The environment key itself is never placed
in this blob.
"""

from __future__ import annotations

import json
from typing import Any

from shared.constants import RUN_HOOK_PAYLOAD_VERSION
from shared.types import LauncherConfig, WebhookEvent

# Keys that must never appear anywhere in the run hook payload.
_FORBIDDEN_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_ENVIRONMENT_KEY")


def build_run_hook_payload(event: WebhookEvent, cfg: LauncherConfig) -> str:
    """Build the run hook payload JSON string for a started session."""
    session: dict[str, Any] = {
        "ANTHROPIC_SESSION_ID": event.session_id,
        "ANTHROPIC_ENVIRONMENT_ID": cfg.environment_id,
        "ENVIRONMENT_KEY_SECRET_ID": cfg.environment_key_secret_id,
        "AWS_REGION": cfg.aws_region,
    }
    if cfg.base_url is not None:
        session["ANTHROPIC_BASE_URL"] = cfg.base_url

    return json.dumps({"version": RUN_HOOK_PAYLOAD_VERSION, "session": session})
