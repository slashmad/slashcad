"""Resident CAD worker for SlashCAD (build123d / OpenCascade).

Speaks newline-delimited JSON over a private copy of stdout; fd 1 itself is
redirected to stderr so OpenCascade or user scripts printing cannot corrupt it.
"""

PROTOCOL_VERSION = 1
