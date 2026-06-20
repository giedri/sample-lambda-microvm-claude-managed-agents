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
    """Build an Anthropic client authenticated with the ORG API key."""
    try:
        from anthropic import Anthropic
    except ImportError:
        sys.exit("The 'anthropic' package is required: pip install anthropic")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY (organization-scoped) must be set for the operator.")
    # The SDK sets the managed-agents beta header automatically.
    return Anthropic(api_key=api_key)


def create_session(client, environment_id: str, agent_id: str) -> None:
    """Create a session targeting the self-hosted environment.

    When the session reaches the running state, Anthropic delivers a
    session.status_run_started webhook to the API Gateway endpoint, which leads
    to a MicroVM launch.
    """
    session = client.beta.sessions.create(agent=agent_id, environment_id=environment_id)
    session_id = getattr(session, "id", session)
    print(f"created session id={session_id}")
    print(
        "If the webhook endpoint is registered, a session.status_run_started "
        "event will trigger a MicroVM launch. Confirm with:\n"
        "  aws lambda-microvms list-microvms --image-identifier <image>\n"
        "  aws lambda-microvms get-microvm --microvm-identifier <id>"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the Claude MicroVM Sandbox (webhook).")
    parser.add_argument("--create", action="store_true", help="Create a session to exercise the flow.")
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
    create_session(client, environment_id, agent_id)


if __name__ == "__main__":
    main()
