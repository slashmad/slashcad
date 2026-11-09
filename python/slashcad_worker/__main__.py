"""Entry point: `python -m slashcad_worker`. One JSON object per line in both directions.

Request:  {"id": 1, "cmd": "build", "params": {...}}
Reply:    {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "...", "traceback": "..."}
Event:    {"event": "progress", "id": 1, "message": "..."}
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback

# Keep a private handle to the real stdout for the protocol, then point fd 1 at stderr so
# OpenCascade's C++ messages and user prints can never corrupt the stream.
_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
_lock = threading.Lock()


def send(obj: dict) -> None:
    line = json.dumps(obj, separators=(",", ":"))
    with _lock:
        _proto.write(line + "\n")
        _proto.flush()


t0 = time.perf_counter()
from . import PROTOCOL_VERSION  # noqa: E402
from .worker import Worker  # noqa: E402  (imports build123d: ~2 s)

worker = Worker(send)
send({"event": "ready", "protocol": PROTOCOL_VERSION, "startup_s": round(time.perf_counter() - t0, 2),
      "python": sys.version.split()[0], "pid": os.getpid()})

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        send({"event": "protocol_error", "message": str(e)})
        continue
    rid = req.get("id")
    try:
        handler = getattr(worker, "cmd_" + req.get("cmd", ""), None)
        if handler is None:
            raise ValueError(f"unknown command {req.get('cmd')!r}")
        send({"id": rid, "ok": True, "result": handler(rid, req.get("params") or {})})
    except BaseException as e:  # noqa: BLE001
        send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()})
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            break
