"""Token-bucket rate limiter for the RunMicrovm API."""

from __future__ import annotations

import threading
import time
from typing import Callable


class TokenBucket:
    """A thread-safe token bucket rate limiter."""

    def __init__(
        self,
        rate_per_second: float,
        *,
        capacity: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if rate_per_second <= 0:
            raise ValueError("rate_per_second must be positive")
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._rate = float(rate_per_second)
        self._capacity = float(capacity)
        self._epsilon = 1e-6
        self._tokens = float(capacity)
        self._clock = clock
        self._sleep = sleep
        self._last = clock()
        self._lock = threading.Lock()

    def _refill_locked(self) -> None:
        now = self._clock()
        elapsed = now - self._last
        if elapsed > 0:
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
            self._last = now

    def try_acquire(self) -> bool:
        """Consume one token without blocking; return whether one was available."""
        with self._lock:
            self._refill_locked()
            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return True
            return False

    def acquire(self) -> None:
        """Block until a token is available, then consume it."""
        while True:
            with self._lock:
                self._refill_locked()
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = max(self._epsilon, (1.0 - self._tokens) / self._rate)
            self._sleep(wait)
