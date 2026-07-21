"""Core data types for the launcher."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from shared.constants import (
    DEFAULT_LAUNCH_TPS_LIMIT,
    DEFAULT_MAX_LIFETIME_SECONDS,
)


@dataclass(frozen=True)
class LauncherConfig:
    """Configuration for the launcher Lambda."""

    environment_id: str
    image_identifier: str
    environment_key_param_name: str
    execution_role_arn: str
    aws_region: str
    signing_param_name: Optional[str] = None
    base_url: Optional[str] = None
    max_lifetime_seconds: int = DEFAULT_MAX_LIFETIME_SECONDS
    launch_tps_limit: int = DEFAULT_LAUNCH_TPS_LIMIT


@dataclass
class WebhookEvent:
    """A parsed Anthropic webhook event."""

    event_id: str
    data_type: str
    session_id: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "WebhookEvent":
        # The webhook envelope's top-level "type" is always the literal object
        # type "event"; the actual event kind (e.g. "session.status_run_started")
        # and the session id live under "data" as {"type": ..., "id": "sesn_..."}.
        # The launcher gates on the event kind, so data_type must come from
        # data["type"] — not the top-level "type".
        data = payload.get("data", {}) or {}
        return cls(
            event_id=payload.get("id", ""),
            data_type=data.get("type", ""),
            session_id=data.get("id", ""),
        )
