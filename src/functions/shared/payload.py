"""Run-hook payload construction.

Builds the per-session dispatch blob delivered to the MicroVM via runHookPayload
(the request body of the /run lifecycle hook). Contains only non-secret data:
session id, environment id, region, and the auth-mode fields — either a
*reference* (name) to the SSM SecureString holding the environment key
(first-party mode), or the workspace id and optional cross-account role ARN
(Claude Platform on AWS, SigV4). No credential of any kind is placed in this
blob; the worker derives its auth path from which fields are present.
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
        "AWS_REGION": cfg.aws_region,
    }
    if cfg.environment_key_param_name:
        session["ENVIRONMENT_KEY_PARAM_NAME"] = cfg.environment_key_param_name
    if cfg.anthropic_aws_workspace_id:
        session["ANTHROPIC_AWS_WORKSPACE_ID"] = cfg.anthropic_aws_workspace_id
    if cfg.anthropic_access_role_arn:
        session["ANTHROPIC_ACCESS_ROLE_ARN"] = cfg.anthropic_access_role_arn
    if cfg.base_url is not None:
        session["ANTHROPIC_BASE_URL"] = cfg.base_url

    return json.dumps({"version": RUN_HOOK_PAYLOAD_VERSION, "session": session})
