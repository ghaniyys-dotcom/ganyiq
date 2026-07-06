"""
env_utils.py — Environment variable loading for GANYIQ.

Replaces duplicate load_env_vars() in run.py and diarize.py.
"""

import os
from pathlib import Path


def load_env_vars(env_path: str | Path | None = None) -> None:
    """Manually parse a .env / .env.local file and set environment variables.

    Looks for the file at *env_path*, or walks up from the caller's directory
    to find ``.env.local`` relative to the script location.
    """
    if env_path is None:
        # Guess: look for .env.local relative to script location
        import sys
        try:
            frame = sys._getframe(1)
            caller_file = frame.f_globals.get('__file__')
            if caller_file:
                env_path = Path(caller_file).resolve().parent / '.env.local'
        except Exception:
            env_path = Path('.env.local')

    env_path = Path(env_path).resolve() if not isinstance(env_path, Path) else env_path

    if not env_path.exists():
        return

    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ.setdefault(key.strip(), value.strip())
    except Exception:
        pass
