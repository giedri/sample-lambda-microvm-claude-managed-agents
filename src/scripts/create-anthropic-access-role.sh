#!/bin/bash
# Create the cross-account Anthropic access role for the Claude MicroVM sandbox.
#
# Run this with credentials for the SUBSCRIBED account (the AWS account that
# completed Claude Platform on AWS sign-up and owns the workspace). It creates
# a role that:
#   - trusts the MicroVM execution role in the COMPUTE account (where the
#     sandbox stack and MicroVMs run), and
#   - carries the AnthropicSelfHostedEnvironmentAccess managed policy, the
#     narrowest policy sufficient for a self-hosted sandbox worker.
#
# The in-VM worker then does sts:AssumeRole into this role and SigV4-signs
# Claude Platform on AWS requests with the assumed credentials.
#
# Usage:
#   ./create-anthropic-access-role.sh
#
# Environment overrides:
#   SUBSCRIBED_ACCOUNT_ID  Account this role is created in   (default: <SUBSCRIBED_ACCOUNT_ID>)
#   COMPUTE_ACCOUNT_ID     Account the MicroVMs run in       (default: <COMPUTE_ACCOUNT_ID>)
#   ROLE_NAME              Name of the role to create        (default: claude-microvm-anthropic-access)
#   EXECUTION_ROLE_NAME    Trusted MicroVM execution role    (default: claude-microvm-sandbox-microvm-execution-role)
set -euo pipefail

SUBSCRIBED_ACCOUNT_ID="${SUBSCRIBED_ACCOUNT_ID:-<SUBSCRIBED_ACCOUNT_ID>}"
COMPUTE_ACCOUNT_ID="${COMPUTE_ACCOUNT_ID:-<COMPUTE_ACCOUNT_ID>}"
ROLE_NAME="${ROLE_NAME:-claude-microvm-anthropic-access}"
EXECUTION_ROLE_NAME="${EXECUTION_ROLE_NAME:-claude-microvm-sandbox-microvm-execution-role}"

EXECUTION_ROLE_ARN="arn:aws:iam::${COMPUTE_ACCOUNT_ID}:role/${EXECUTION_ROLE_NAME}"
MANAGED_POLICY_ARN="arn:aws:iam::aws:policy/AnthropicSelfHostedEnvironmentAccess"

# --- Guard: must be running in the subscribed account, not the compute account.
CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "${CALLER_ACCOUNT}" != "${SUBSCRIBED_ACCOUNT_ID}" ]]; then
  echo "ERROR: current credentials are for account ${CALLER_ACCOUNT}." >&2
  echo "This role must be created in the SUBSCRIBED account ${SUBSCRIBED_ACCOUNT_ID}" >&2
  echo "(the account with the Claude Platform on AWS subscription)." >&2
  echo "Switch profiles, e.g.: AWS_PROFILE=<subscribed-account-profile> $0" >&2
  exit 1
fi

TRUST_POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "${EXECUTION_ROLE_ARN}" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)"

echo "Account:            ${CALLER_ACCOUNT} (subscribed)"
echo "Creating role:      ${ROLE_NAME}"
echo "Trusted principal:  ${EXECUTION_ROLE_ARN}"
echo "Attaching policy:   ${MANAGED_POLICY_ARN}"
echo

# --- Create or update (idempotent).
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "Role ${ROLE_NAME} already exists — updating trust policy."
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "${TRUST_POLICY}"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "Assumed by the Claude MicroVM sandbox worker in ${COMPUTE_ACCOUNT_ID} to call Claude Platform on AWS." \
    --tags Key=auto-delete,Value=no \
    >/dev/null
  echo "Role created."
fi

# attach-role-policy is idempotent (no-op if already attached).
aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "${MANAGED_POLICY_ARN}"
echo "Managed policy attached."

# The gateway exchanges the SigV4 identity for a web-identity token via
# sts:GetWebIdentityToken / sts:TagGetWebIdentityToken (outbound web identity
# federation). The Anthropic managed policy does not include these STS actions,
# so grant them inline.
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name allow-get-web-identity-token \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"sts:GetWebIdentityToken\",\"sts:TagGetWebIdentityToken\"],\"Resource\":\"arn:aws:sts::${SUBSCRIBED_ACCOUNT_ID}:self\"}]}"
echo "sts:GetWebIdentityToken / sts:TagGetWebIdentityToken inline policy attached."

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
echo
echo "Done. Role ARN:"
echo "  ${ROLE_ARN}"
echo
echo "Next steps (in the compute account ${COMPUTE_ACCOUNT_ID}):"
echo "  1. Pass this ARN as the AnthropicAccessRoleArn stack parameter."
echo "  2. Deploy the stack and rebuild the MicroVM image."
