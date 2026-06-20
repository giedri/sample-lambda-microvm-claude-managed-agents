"""Client for the AWS Lambda MicroVM RunMicrovm API.

Uses SigV4-signed raw HTTPS requests so the launcher does not depend on the
``lambda-microvms`` service model being present in the bundled boto3/botocore.
Where that service model is available, this can be replaced with
``boto3.client("lambda-microvms").run_microvm(...)``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol, Sequence, runtime_checkable

# SigV4 signing name.
DEFAULT_SIGNING_NAME = "lambda"
# API path for RunMicrovm (POST).
DEFAULT_API_PATH = "/2025-09-09/microvms"
# Request field names.
DEFAULT_IMAGE_FIELD = "imageIdentifier"
DEFAULT_RUN_HOOK_PAYLOAD_FIELD = "runHookPayload"
DEFAULT_MAX_LIFETIME_FIELD = "maximumDurationInSeconds"
DEFAULT_EXECUTION_ROLE_FIELD = "executionRoleArn"
DEFAULT_IDLE_POLICY_FIELD = "idlePolicy"
DEFAULT_INGRESS_FIELD = "ingressNetworkConnectors"
DEFAULT_EGRESS_FIELD = "egressNetworkConnectors"
# Response field names.
DEFAULT_MICROVM_ID_FIELD = "microvmId"
DEFAULT_ENDPOINT_FIELD = "endpoint"

MIN_DURATION_SECONDS = 1
MAX_DURATION_SECONDS = 28800


class LaunchMicroVmError(Exception):
    """Raised when RunMicrovm fails."""

    def __init__(
        self,
        message: str,
        *,
        session_id: Optional[str] = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        super().__init__(message)
        self.session_id = session_id
        self.cause = cause


@dataclass(frozen=True)
class LaunchedMicroVm:
    """Result of a successful RunMicrovm call."""

    microvm_id: str
    endpoint: str


@runtime_checkable
class MicroVmClient(Protocol):
    """Abstract interface for launching MicroVMs."""

    def launch_microvm(
        self,
        image_identifier: str,
        run_hook_payload: Optional[str] = None,
        max_lifetime_seconds: Optional[int] = None,
        execution_role_arn: Optional[str] = None,
        idle_policy: Optional[Mapping[str, Any]] = None,
        logging_config: Optional[Mapping[str, Any]] = None,
        ingress_network_connectors: Optional[Sequence[str]] = None,
        egress_network_connectors: Optional[Sequence[str]] = None,
    ) -> LaunchedMicroVm:
        ...


class SignedMicroVmClient:
    """SigV4-signed HTTPS client for the RunMicrovm API."""

    def __init__(
        self,
        *,
        region_name: str,
        endpoint_url: Optional[str] = None,
        signing_name: str = DEFAULT_SIGNING_NAME,
        api_path: str = DEFAULT_API_PATH,
        credentials: Optional[Any] = None,
        http_session: Optional[Any] = None,
        image_field: str = DEFAULT_IMAGE_FIELD,
        run_hook_payload_field: str = DEFAULT_RUN_HOOK_PAYLOAD_FIELD,
        max_lifetime_field: str = DEFAULT_MAX_LIFETIME_FIELD,
        execution_role_field: str = DEFAULT_EXECUTION_ROLE_FIELD,
        idle_policy_field: str = DEFAULT_IDLE_POLICY_FIELD,
        ingress_field: str = DEFAULT_INGRESS_FIELD,
        egress_field: str = DEFAULT_EGRESS_FIELD,
        microvm_id_field: str = DEFAULT_MICROVM_ID_FIELD,
        endpoint_field: str = DEFAULT_ENDPOINT_FIELD,
    ) -> None:
        self._region = region_name
        self._endpoint_url = (endpoint_url or f"https://lambda.{region_name}.amazonaws.com").rstrip("/")
        self._signing_name = signing_name
        self._api_path = api_path
        self._credentials = credentials
        self._http_session = http_session
        self._image_field = image_field
        self._run_hook_payload_field = run_hook_payload_field
        self._max_lifetime_field = max_lifetime_field
        self._execution_role_field = execution_role_field
        self._idle_policy_field = idle_policy_field
        self._ingress_field = ingress_field
        self._egress_field = egress_field
        self._microvm_id_field = microvm_id_field
        self._endpoint_field = endpoint_field

    def _get_credentials(self) -> Any:
        if self._credentials is None:
            import botocore.session  # type: ignore[import-not-found]

            creds = botocore.session.get_session().get_credentials()
            if creds is None:
                raise LaunchMicroVmError("no AWS credentials available to sign LaunchMicroVM")
            self._credentials = creds
        return self._credentials

    def launch_microvm(
        self,
        image_identifier: str,
        run_hook_payload: Optional[str] = None,
        max_lifetime_seconds: Optional[int] = None,
        execution_role_arn: Optional[str] = None,
        idle_policy: Optional[Mapping[str, Any]] = None,
        logging_config: Optional[Mapping[str, Any]] = None,
        ingress_network_connectors: Optional[Sequence[str]] = None,
        egress_network_connectors: Optional[Sequence[str]] = None,
    ) -> LaunchedMicroVm:
        if not image_identifier:
            raise LaunchMicroVmError("image_identifier is required to launch a MicroVM")
        if max_lifetime_seconds is not None and not (
            MIN_DURATION_SECONDS <= max_lifetime_seconds <= MAX_DURATION_SECONDS
        ):
            raise LaunchMicroVmError(
                "max_lifetime_seconds must be between "
                f"{MIN_DURATION_SECONDS} and {MAX_DURATION_SECONDS}"
            )

        body: dict[str, Any] = {self._image_field: image_identifier}
        if run_hook_payload is not None:
            body[self._run_hook_payload_field] = run_hook_payload
        if max_lifetime_seconds is not None:
            body[self._max_lifetime_field] = max_lifetime_seconds
        if execution_role_arn is not None:
            body[self._execution_role_field] = execution_role_arn
        if idle_policy is not None:
            body[self._idle_policy_field] = dict(idle_policy)
        if logging_config is not None:
            body["logging"] = dict(logging_config)
        if ingress_network_connectors is not None:
            body[self._ingress_field] = list(ingress_network_connectors)
        if egress_network_connectors is not None:
            body[self._egress_field] = list(egress_network_connectors)

        url = f"{self._endpoint_url}{self._api_path}"
        try:
            status, resp_text = self._send_signed(url, json.dumps(body))
        except LaunchMicroVmError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced as LaunchMicroVmError
            raise LaunchMicroVmError(
                f"LaunchMicroVM request failed for image '{image_identifier}': {exc}",
                cause=exc,
            ) from exc

        if status < 200 or status >= 300:
            raise LaunchMicroVmError(
                f"LaunchMicroVM returned HTTP {status} for image '{image_identifier}': {resp_text}"
            )

        try:
            response = json.loads(resp_text) if resp_text else {}
        except json.JSONDecodeError as exc:
            raise LaunchMicroVmError(
                f"LaunchMicroVM response was not JSON: {resp_text!r}", cause=exc
            ) from exc

        microvm_id = response.get(self._microvm_id_field)
        endpoint = response.get(self._endpoint_field)
        if not microvm_id or not endpoint:
            raise LaunchMicroVmError(
                f"LaunchMicroVM response missing id/endpoint: {response!r}"
            )
        return LaunchedMicroVm(microvm_id=microvm_id, endpoint=endpoint)

    def _send_signed(self, url: str, body: str) -> tuple[int, str]:
        """SigV4-sign and POST the request. Returns (status_code, response_text)."""
        from botocore.auth import SigV4Auth  # type: ignore[import-not-found]
        from botocore.awsrequest import AWSRequest  # type: ignore[import-not-found]
        from botocore.httpsession import URLLib3Session  # type: ignore[import-not-found]

        creds = self._get_credentials().get_frozen_credentials()
        aws_req = AWSRequest(
            method="POST",
            url=url,
            data=body.encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        SigV4Auth(creds, self._signing_name, self._region).add_auth(aws_req)
        session = self._http_session or URLLib3Session(
            timeout=(HTTP_CONNECT_TIMEOUT_SECONDS, HTTP_READ_TIMEOUT_SECONDS),
        )
        response = session.send(aws_req.prepare())
        return response.status_code, response.text


HTTP_CONNECT_TIMEOUT_SECONDS = 5
HTTP_READ_TIMEOUT_SECONDS = 10
