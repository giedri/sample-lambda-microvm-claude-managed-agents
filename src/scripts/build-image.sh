#!/bin/bash
# Build the Claude self-hosted worker MicroVM image.
#
# Steps:
#   1. Zips microvm-image/ into app.zip (Dockerfile at the root), excluding
#      local-only artifacts (node_modules, lockfiles) — the Dockerfile runs its
#      own `npm install`, so shipping them only bloats the artifact.
#   2. Uploads to the stack's S3 artifact bucket.
#   3. Creates the MicroVM image, or updates it in place if one already exists
#      with the same name (create-microvm-image rejects a duplicate name).
#
# Usage:
#   ./build-image.sh [stack-name]
#
# Environment overrides:
#   IMAGE_NAME     MicroVM image name        (default: claude-self-hosted-worker)
#   BASE_IMAGE_ARN Managed base image ARN    (default: auto-discovered)
#   S3_KEY         Artifact key in bucket    (default: deployments/app-<timestamp>.zip)
#   AWS_REGION     Target region             (default: from AWS CLI config)
#   WORKER_DEBUG   Set to 1 to bake WORKER_DEBUG=1 into the image (verbose
#                  inbound-traffic + poll-cycle + tool-call logging to
#                  CloudWatch). Unset/other clears it. Off by default — the
#                  logs may contain sensitive payloads.
set -euo pipefail

STACK_NAME="${1:-claude-microvm-sandbox}"
IMAGE_NAME="${IMAGE_NAME:-claude-self-hosted-worker}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_SRC="${REPO_ROOT}/microvm-image"

# ${ARR[@]+"${ARR[@]}"} expansions below: empty-array-safe under `set -u` on
# bash 3.2 (macOS default), which treats "${ARR[@]}" of an empty array as unbound.
REGION_ARG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_ARG=(--region "${AWS_REGION}")
fi

echo "Resolving artifact bucket and build role from stack '${STACK_NAME}'..."
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" \
  --output text ${REGION_ARG[@]+"${REGION_ARG[@]}"})"
BUILD_ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='BuildRoleArn'].OutputValue" \
  --output text ${REGION_ARG[@]+"${REGION_ARG[@]}"})"

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  echo "Could not resolve ArtifactBucketName from stack '${STACK_NAME}'." >&2
  exit 1
fi

# Discover the managed base image ARN if not provided.
if [[ -z "${BASE_IMAGE_ARN:-}" ]]; then
  echo "Discovering a managed base image via list-managed-microvm-images..."
  BASE_IMAGE_ARN="$(aws lambda-microvms list-managed-microvm-images \
    --query "items[0].imageArn" --output text ${REGION_ARG[@]+"${REGION_ARG[@]}"})"
  if [[ -z "${BASE_IMAGE_ARN}" || "${BASE_IMAGE_ARN}" == "None" ]]; then
    echo "Could not discover a managed base image. Set BASE_IMAGE_ARN explicitly." >&2
    exit 1
  fi
fi
echo "Using base image: ${BASE_IMAGE_ARN}"

# 1. Zip the image source (Dockerfile must be at the archive root).
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
S3_KEY="${S3_KEY:-deployments/app-${TIMESTAMP}.zip}"
TMP_DIR="$(mktemp -d)"
TMP_ZIP="${TMP_DIR}/app.zip"
trap 'rm -rf "${TMP_DIR}"' EXIT

# Exclude local-only build artifacts: the Dockerfile COPYs package.json and
# runs `npm install --omit=dev` itself, so a checked-out node_modules/ or
# lockfile would only bloat the archive (and has caused multi-MB uploads).
echo "Packaging ${IMAGE_SRC} -> ${TMP_ZIP}..."
( cd "${IMAGE_SRC}" && zip -r -q "${TMP_ZIP}" . \
    -x '*/node_modules/*' 'worker/package-lock.json' '*.DS_Store' )

# 2. Upload to S3.
echo "Uploading to s3://${BUCKET}/${S3_KEY}..."
aws s3 cp "${TMP_ZIP}" "s3://${BUCKET}/${S3_KEY}" ${REGION_ARG[@]+"${REGION_ARG[@]}"}

# Shared image spec (same hooks for create and update).
HOOKS='{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":300},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":5,"resume":"ENABLED","resumeTimeoutInSeconds":5,"suspend":"ENABLED","suspendTimeoutInSeconds":5,"terminate":"ENABLED","terminateTimeoutInSeconds":5}}'

# Optional debug env var, baked into the image when WORKER_DEBUG=1.
ENV_ARG=()
if [[ "${WORKER_DEBUG:-}" == "1" ]]; then
  echo "WORKER_DEBUG=1: baking verbose logging into the image."
  ENV_ARG=(--environment-variables '{"WORKER_DEBUG":"1"}')
fi

# 3. Create the image, or update it in place if the name already exists.
# create-microvm-image rejects a duplicate name, so check first and branch.
EXISTING_ARN="$(aws lambda-microvms get-microvm-image \
  --image-identifier "${IMAGE_NAME}" \
  --query "imageArn" --output text ${REGION_ARG[@]+"${REGION_ARG[@]}"} 2>/dev/null || true)"

if [[ -n "${EXISTING_ARN}" && "${EXISTING_ARN}" != "None" ]]; then
  echo "Image '${IMAGE_NAME}' exists (${EXISTING_ARN}); updating in place..."
  aws lambda-microvms update-microvm-image \
    --image-identifier "${EXISTING_ARN}" \
    --code-artifact "uri=s3://${BUCKET}/${S3_KEY}" \
    --base-image-arn "${BASE_IMAGE_ARN}" \
    --build-role-arn "${BUILD_ROLE_ARN}" \
    --hooks "${HOOKS}" \
    ${ENV_ARG[@]+"${ENV_ARG[@]}"} \
    ${REGION_ARG[@]+"${REGION_ARG[@]}"}
else
  echo "Creating MicroVM image '${IMAGE_NAME}'..."
  aws lambda-microvms create-microvm-image \
    --code-artifact "uri=s3://${BUCKET}/${S3_KEY}" \
    --name "${IMAGE_NAME}" \
    --base-image-arn "${BASE_IMAGE_ARN}" \
    --build-role-arn "${BUILD_ROLE_ARN}" \
    --hooks "${HOOKS}" \
    ${ENV_ARG[@]+"${ENV_ARG[@]}"} \
    ${REGION_ARG[@]+"${REGION_ARG[@]}"}
fi

echo
echo "Image build started. Monitor build logs in CloudWatch:"
echo "  /aws/lambda/microvms/${IMAGE_NAME}"
echo "The image transitions to CREATED/UPDATED on success."
