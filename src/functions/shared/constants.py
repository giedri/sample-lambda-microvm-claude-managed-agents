"""Shared constants for the launcher."""

# AWS-managed network connector ARN templates.
ALL_INGRESS_TEMPLATE = "arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:ALL_INGRESS"
INTERNET_EGRESS_TEMPLATE = "arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"


def all_ingress_arn(region: str) -> str:
    """ALL_INGRESS connector ARN for the given region."""
    return ALL_INGRESS_TEMPLATE.format(region=region)


def internet_egress_arn(region: str) -> str:
    """INTERNET_EGRESS connector ARN for the given region."""
    return INTERNET_EGRESS_TEMPLATE.format(region=region)

DEFAULT_MAX_LIFETIME_SECONDS = 28800  # 8 hours

DEFAULT_LAUNCH_TPS_LIMIT = 5

RUN_HOOK_PAYLOAD_VERSION = "1"

MANAGED_AGENTS_BETA_HEADER = "managed-agents-2026-04-01"

DEFAULT_IDLE_POLICY = {
    "maxIdleDurationSeconds": 300,
    "suspendedDurationSeconds": 60,
    "autoResumeEnabled": False,
}

DEFAULT_LOGGING_CONFIG = {
    "cloudWatch": {
        "logGroup": "/aws/lambda/microvms/claude-self-hosted-worker",
    }
}

SESSION_RUN_STARTED = "session.status_run_started"
