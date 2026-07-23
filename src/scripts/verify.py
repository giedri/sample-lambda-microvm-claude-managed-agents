"""Operator-side verification for the Claude MicroVM Sandbox (webhook model).

Run this from OUTSIDE the control plane using your organization API key. It
creates a session targeting the self-hosted environment, which (once the session
reaches the running state) causes Anthropic to deliver a
``session.status_run_started`` webhook to your API Gateway endpoint. The
launcher Lambda verifies the signature in-process and starts one MicroVM.

You then confirm a MicroVM reached the RUNNING state with the AWS CLI:

    aws lambda-microvms list-microvms --image-identifier <image>
    aws lambda-microvms get-microvm --microvm-identifier <id>

Credentials (operator scope only — never on the control plane):

  ANTHROPIC_API_KEY          Organization-scoped key, used to create sessions.
  ANTHROPIC_ENVIRONMENT_ID   The self-hosted environment id.
  AGENT_ID                   The agent to run in the session.

Usage:
  python verify.py --create   # create a session to exercise the webhook flow
"""

from __future__ import annotations

import argparse
import os
import sys


def _client():
    """Build an Anthropic client for the operator.

    Two auth modes are supported:

    * Organization API key (``sk-ant-...``) via ``ANTHROPIC_API_KEY`` — uses the
      standard ``Anthropic`` client.
    * AWS-brokered key (``aws-external-anthropic-api-key-...``) via
      ``ANTHROPIC_AWS_API_KEY`` — uses the ``AnthropicAWS`` client, which also
      requires a workspace id in ``ANTHROPIC_AWS_WORKSPACE_ID`` (must be the
      workspace *id*, e.g. ``wrkspc_...``, not the display name).
    """
    aws_api_key = os.environ.get("ANTHROPIC_AWS_API_KEY")
    if aws_api_key:
        try:
            from anthropic import AnthropicAWS
        except ImportError:
            sys.exit("The 'anthropic' package is required: pip install anthropic")
        if not os.environ.get("ANTHROPIC_AWS_WORKSPACE_ID"):
            sys.exit(
                "ANTHROPIC_AWS_WORKSPACE_ID must be set when using ANTHROPIC_AWS_API_KEY "
                "(use the workspace id, e.g. wrkspc_..., not the workspace name)."
            )
        # api_key and workspace_id are read from the environment by the SDK.
        return AnthropicAWS()

    try:
        from anthropic import Anthropic
    except ImportError:
        sys.exit("The 'anthropic' package is required: pip install anthropic")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit(
            "Set ANTHROPIC_API_KEY (organization-scoped sk-ant- key) or "
            "ANTHROPIC_AWS_API_KEY (with ANTHROPIC_AWS_WORKSPACE_ID) for the operator."
        )
    # The SDK sets the managed-agents beta header automatically.
    return Anthropic(api_key=api_key)


def create_session(client, environment_id: str, agent_id: str, prompt: str) -> None:
    """Create a session and start a run so the webhook fires.

    Creating a session leaves it in the ``idle`` state, which does NOT emit a
    ``session.status_run_started`` webhook. A run only begins when an event is
    sent to the session; that transition is what Anthropic delivers to the API
    Gateway endpoint, leading to a MicroVM launch. So we create the session and
    then send an initial user message to kick off a run.
    """
    session = client.beta.sessions.create(agent=agent_id, environment_id=environment_id)
    session_id = getattr(session, "id", session)
    print(f"created session id={session_id}")

    client.beta.sessions.events.send(
        session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
    )
    print(f"started run (sent user.message) on session id={session_id}")
    print(
        "If the webhook endpoint is registered, the session.status_run_started "
        "event will trigger a MicroVM launch. Confirm with:\n"
        "  aws lambda-microvms list-microvms --image-identifier <image>\n"
        "  aws lambda-microvms get-microvm --microvm-identifier <id>"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the Claude MicroVM Sandbox (webhook).")
    parser.add_argument("--create", action="store_true", help="Create a session and start a run to exercise the flow.")
    parser.add_argument(
        "--prompt",
        default="Fetch and summarize the latest AWS Compute Blog article.",
        help="Initial user message used to start the run.",
    )
    args = parser.parse_args()

    environment_id = os.environ.get("ANTHROPIC_ENVIRONMENT_ID")
    if not environment_id:
        sys.exit("ANTHROPIC_ENVIRONMENT_ID must be set.")

    if not args.create:
        print("Nothing to do. Pass --create to create a session and exercise the webhook flow.")
        return

    agent_id = os.environ.get("AGENT_ID")
    if not agent_id:
        sys.exit("AGENT_ID must be set to create a session.")

    client = _client()
    create_session(client, environment_id, agent_id, args.prompt)


if __name__ == "__main__":
    main()
