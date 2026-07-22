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
    execution_role_arn: str
    aws_region: str
    # Auth mode — exactly one of these is set (enforced by the template Rules):
    # environment_key_param_name → first-party Claude API (bearer environment
    # key, fetched from SSM by the worker); anthropic_aws_workspace_id → Claude
    # Platform on AWS (SigV4), with anthropic_access_role_arn optionally naming
    # a cross-account role to assume.
    environment_key_param_name: Optional[str] = None
    anthropic_aws_workspace_id: Optional[str] = None
    anthropic_access_role_arn: Optional[str] = None
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
        data = payload.get("data", {}) or {}
        return cls(
            event_id=payload.get("id", ""),
            data_type=data.get("type", ""),
            session_id=data.get("id", ""),
        )
