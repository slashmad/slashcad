#!/usr/bin/env bash
# Runs the same WebGL bench in Electron and WebKitGTK, one at a time, against one GLB.
# Usage: ./run.sh <model.glb> <results.jsonl> [port]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
model="$(realpath "$1")"; results="$(realpath -m "$2")"; port="${3:-18731}"; extra="${BENCH_QUERY:-}"
: > "$results"

/usr/bin/python3 -I "$here/server.py" "$port" "$model" "$results" &
srv=$!
trap 'kill $srv 2>/dev/null || true' EXIT
sleep 0.5

wait_result() {  # wait until the results file has $1 lines or BENCH_TIMEOUT s (default 120) pass
  for _ in $(seq 1 $(( ${BENCH_TIMEOUT:-120} * 2 ))); do
    [ "$(wc -l < "$results")" -ge "$1" ] && return 0
    sleep 0.5
  done
  echo "timeout waiting for result $1" >&2; return 1
}

run_one() {  # name, expected line count, command...
  local name="$1" n="$2"; shift 2
  echo "== $name"
  "$@" >/dev/null 2>"$here/../../out/spikes/shell-$name.stderr" &
  local pid=$!
  wait_result "$n" || true
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
}

url="http://127.0.0.1:$port/bench.html?model=/model.glb$extra"
run_one electron 1 env -u ELECTRON_RUN_AS_NODE BENCH_URL="$url&engine=electron-x11" "$here/node_modules/.bin/electron" "$here"
run_one electron-wayland 2 env -u ELECTRON_RUN_AS_NODE BENCH_URL="$url&engine=electron-wayland" "$here/node_modules/.bin/electron" --ozone-platform=wayland "$here"
run_one webkitgtk 3 env -u ELECTRON_RUN_AS_NODE /usr/bin/python3 -I "$here/webkitgtk_runner.py" "$url&engine=webkitgtk-4.1"
run_one webkitgtk-nodmabuf 4 env WEBKIT_DISABLE_DMABUF_RENDERER=1 /usr/bin/python3 -I "$here/webkitgtk_runner.py" "$url&engine=webkitgtk-4.1-nodmabuf"
cat "$results"
