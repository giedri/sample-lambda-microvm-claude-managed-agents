"""Client for the AWS Lambda MicroVM RunMicrovm API.

Calls RunMicrovm through the boto3 ``lambda-microvms`` client. boto3 and botocore
are bundled into the deployment package (see ``requirements.txt``) so the client
is available to the launcher at runtime.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol, Sequence, runtime_checkable

# boto3 service name for the lambda-microvms client.
DEFAULT_SERVICE_NAME = "lambda-microvms"

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


class Boto3MicroVmClient:
    """RunMicrovm client backed by the bundled boto3 ``lambda-microvms`` SDK."""

    def __init__(
        self,
        *,
        region_name: str,
        client: Optional[Any] = None,
        service_name: str = DEFAULT_SERVICE_NAME,
    ) -> None:
        self._region = region_name
        self._service_name = service_name
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            import boto3  # type: ignore[import-not-found]

            self._client = boto3.client(self._service_name, region_name=self._region)
        return self._client

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

        # Map to RunMicrovmRequest fields (lambda-microvms 2025-09-09 model).
        params: dict[str, Any] = {"imageIdentifier": image_identifier}
        if run_hook_payload is not None:
            params["runHookPayload"] = run_hook_payload
        if max_lifetime_seconds is not None:
            params["maximumDurationInSeconds"] = max_lifetime_seconds
        if execution_role_arn is not None:
            params["executionRoleArn"] = execution_role_arn
        if idle_policy is not None:
            params["idlePolicy"] = dict(idle_policy)
        if logging_config is not None:
            params["logging"] = dict(logging_config)
        if ingress_network_connectors is not None:
            params["ingressNetworkConnectors"] = list(ingress_network_connectors)
        if egress_network_connectors is not None:
            params["egressNetworkConnectors"] = list(egress_network_connectors)

        try:
            response = self._get_client().run_microvm(**params)
        except LaunchMicroVmError:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced as LaunchMicroVmError
            raise LaunchMicroVmError(
                f"RunMicrovm request failed for image '{image_identifier}': {exc}",
                cause=exc,
            ) from exc

        # RunMicrovmResponse: microvmId + endpoint (2025-09-09 model).
        microvm_id = response.get("microvmId")
        endpoint = response.get("endpoint")
        if not microvm_id or not endpoint:
            raise LaunchMicroVmError(
                f"RunMicrovm response missing id/endpoint: {response!r}"
            )
        return LaunchedMicroVm(microvm_id=microvm_id, endpoint=endpoint)
