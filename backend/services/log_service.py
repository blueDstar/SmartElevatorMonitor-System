from __future__ import annotations

import io
import logging
import sys
from collections import deque
from datetime import datetime

from services.socket_service import emit_log


class SocketLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            module = getattr(record, "module_name", record.name)
            emit_log(module, record.levelname, msg)
        except Exception:
            pass


class InMemoryLogBuffer:
    def __init__(self, maxlen: int = 1000) -> None:
        self.buffer: deque = deque(maxlen=maxlen)

    def append(self, module: str, level: str, message: str) -> None:
        self.buffer.append(
            {
                "timestamp": datetime.now().isoformat(),
                "module": module,
                "level": level,
                "message": message,
            }
        )

    def recent(self, limit: int = 200, module: str | None = None) -> list[dict]:
        items = list(self.buffer)
        if module:
            items = [x for x in items if x["module"] == module]
        return items[-limit:]


LOG_BUFFER = InMemoryLogBuffer()


class BufferLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            module = getattr(record, "module_name", record.name)
            LOG_BUFFER.append(module, record.levelname, msg)
        except Exception:
            pass


def setup_logging(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("smartelevator")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()
    logger.propagate = False

    formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] %(message)s", "%H:%M:%S"
    )

    console_handler = logging.StreamHandler(sys.__stdout__)
    console_handler.setFormatter(formatter)

    socket_handler = SocketLogHandler()
    socket_handler.setFormatter(formatter)

    buffer_handler = BufferLogHandler()
    buffer_handler.setFormatter(formatter)

    logger.addHandler(console_handler)
    logger.addHandler(socket_handler)
    logger.addHandler(buffer_handler)

    return logger


def get_logger(module_name: str) -> logging.LoggerAdapter:
    base_logger = logging.getLogger("smartelevator")
    return logging.LoggerAdapter(base_logger, {"module_name": module_name})


class StreamToLogger(io.TextIOBase):
    """
    Redirect a file-like stream (e.g. sys.stdout) to the smartelevator logger.

    FIXED: self.logger is now assigned in __init__ so write() can call it safely.
    Previously write() called self.logger which didn't exist, causing AttributeError.
    """

    def __init__(self, module_name: str, level: int = logging.INFO):
        super().__init__()
        self.module_name = module_name
        self.level = level
        self.logger = get_logger(module_name)  # FIX: must be here, not deferred
        self._buffer = ""

    def write(self, s):  # noqa: ANN001
        if s is None:
            return 0

        if isinstance(s, bytes):
            s = s.decode("utf-8", errors="replace")
        else:
            s = str(s)

        self._buffer += s

        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.rstrip("\r")
            if line:
                self.logger.log(self.level, line)  # Now safe — logger exists

        return len(s)

    def flush(self) -> None:
        if self._buffer.strip():
            self.logger.log(self.level, self._buffer.strip())
        self._buffer = ""


def install_std_redirects() -> None:
    """
    Redirect sys.stdout and sys.stderr to the smartelevator logger.

    WARNING: Only call this if you deliberately want all print() output to go
    through the log system. Do NOT call in production as it can interfere with
    gunicorn's own logging and cause infinite recursion loops.
    """
    sys.stdout = StreamToLogger("system", logging.INFO)
    sys.stderr = StreamToLogger("system", logging.ERROR)