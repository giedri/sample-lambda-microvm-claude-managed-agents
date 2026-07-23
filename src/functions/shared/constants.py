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

# Session-id launch dedupe window. Every agent turn emits run_started, so
# per-event dedupe would launch one VM per turn; instead the live VM keeps
# polling for the session's next item. Invariant: the worker's idle window
# (WORK_IDLE_EXIT_MS, 360s) must EXCEED this TTL so no turn lands after the
# worker exits but before the record expires — worst case is a redundant
# launch that finds no work and idle-exits, never a dropped turn.
SESSION_DEDUPE_TTL_SECONDS = 300

DEFAULT_LAUNCH_TPS_LIMIT = 5

RUN_HOOK_PAYLOAD_VERSION = "1"

MANAGED_AGENTS_BETA_HEADER = "managed-agents-2026-04-01"

# VM idle policy. The worker exits on its own after WORK_IDLE_EXIT_MS (360s)
# without new work for its session; maxIdleDurationSeconds is a backstop above
# that so the platform never suspends a VM that is still serving turns.
# suspendedDurationSeconds=0 / autoResumeEnabled=False: per-session VMs are
# terminated, not resumed (per the Lambda MicroVMs guidance for this pattern).
DEFAULT_IDLE_POLICY = {
    "maxIdleDurationSeconds": 420,
    "suspendedDurationSeconds": 0,
    "autoResumeEnabled": False,
}

DEFAULT_LOGGING_CONFIG = {
    "cloudWatch": {
        "logGroup": "/aws/lambda/microvms/claude-self-hosted-worker",
    }
}

SESSION_RUN_STARTED = "session.status_run_started"
