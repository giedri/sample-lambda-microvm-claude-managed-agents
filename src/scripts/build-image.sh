#!/bin/bash
# Build the Claude self-hosted worker MicroVM image.
#
# Steps:
#   1. Zips microvm-image/ into app.zip (Dockerfile at the root).
#   2. Uploads to the stack's S3 artifact bucket.
#   3. Creates the MicroVM image with lifecycle hooks enabled.
#
# Usage:
#   ./build-image.sh [stack-name]
#
# Environment overrides:
#   IMAGE_NAME     MicroVM image name        (default: claude-self-hosted-worker)
#   BASE_IMAGE_ARN Managed base image ARN    (default: auto-discovered)
#   S3_KEY         Artifact key in bucket    (default: deployments/app-<timestamp>.zip)
#   AWS_REGION     Target region             (default: from AWS CLI config)
set -euo pipefail

STACK_NAME="${1:-claude-microvm-sandbox}"
IMAGE_NAME="${IMAGE_NAME:-claude-self-hosted-worker}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_SRC="${REPO_ROOT}/microvm-image"

REGION_ARG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_ARG=(--region "${AWS_REGION}")
fi

echo "Resolving artifact bucket and build role from stack '${STACK_NAME}'..."
BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" \
  --output text "${REGION_ARG[@]}")"
BUILD_ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='BuildRoleArn'].OutputValue" \
  --output text "${REGION_ARG[@]}")"

if [[ -z "${BUCKET}" || "${BUCKET}" == "None" ]]; then
  echo "Could not resolve ArtifactBucketName from stack '${STACK_NAME}'." >&2
  exit 1
fi

# Discover the managed base image ARN if not provided.
if [[ -z "${BASE_IMAGE_ARN:-}" ]]; then
  echo "Discovering a managed base image via list-managed-microvm-images..."
  BASE_IMAGE_ARN="$(aws lambda-microvms list-managed-microvm-images \
    --query "items[0].imageArn" --output text "${REGION_ARG[@]}")"
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

echo "Packaging ${IMAGE_SRC} -> ${TMP_ZIP}..."
( cd "${IMAGE_SRC}" && zip -r -q "${TMP_ZIP}" . )

# 2. Upload to S3.
echo "Uploading to s3://${BUCKET}/${S3_KEY}..."
aws s3 cp "${TMP_ZIP}" "s3://${BUCKET}/${S3_KEY}" "${REGION_ARG[@]}"

# 3. Create the MicroVM image.
echo "Creating MicroVM image '${IMAGE_NAME}'..."
aws lambda-microvms create-microvm-image \
  --code-artifact "uri=s3://${BUCKET}/${S3_KEY}" \
  --name "${IMAGE_NAME}" \
  --base-image-arn "${BASE_IMAGE_ARN}" \
  --build-role-arn "${BUILD_ROLE_ARN}" \
  --hooks '{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":300,"validate":"ENABLED","validateTimeoutInSeconds":300},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":5,"resume":"ENABLED","resumeTimeoutInSeconds":5,"suspend":"ENABLED","suspendTimeoutInSeconds":5,"terminate":"ENABLED","terminateTimeoutInSeconds":5}}' \
  "${REGION_ARG[@]}"

echo
echo "Image build started. Monitor build logs in CloudWatch:"
echo "  /aws/lambda/microvms/${IMAGE_NAME}"
echo "The image transitions CREATING -> CREATED on success."
