"""
logger.py — Unified structured logging for GANYIQ.

All modules use this for consistent ``[GANYIQ:MODULE] timestamp message`` output.
"""

import sys


def log(module: str, msg: str, stream=sys.stderr):
    """Emit a structured log line: ``[GANYIQ:{module}] {msg}``.

    Args:
        module: Short module name (e.g. 'PIPELINE', 'DIARIZE', 'ASD').
        msg: Log message text.
        stream: Output stream (default stderr).
    """
    print(f"[GANYIQ:{module}] {msg}", file=stream, flush=True)


def warn(module: str, msg: str, stream=sys.stderr):
    """Emit a warning log line."""
    print(f"[GANYIQ:{module}] WARN: {msg}", file=stream, flush=True)


def error(module: str, msg: str, stream=sys.stderr):
    """Emit an error log line."""
    print(f"[GANYIQ:{module}] ERROR: {msg}", file=stream, flush=True)
