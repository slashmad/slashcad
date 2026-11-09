"""Drive the worker over its stdio protocol like the app does. Usage: worker-smoke.py <project> <cache> <src>..."""
import json, subprocess, sys, time, os
proj, cache, *srcs = sys.argv[1:]
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ, PYTHONPATH=os.path.join(here, "..", "python"))
p = subprocess.Popen([sys.executable, "-m", "slashcad_worker"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
def recv():
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("event") == "progress": print("  progress:", m["message"]); continue
        return m
print("ready:", recv())
for rnd in range(2):
    t = time.perf_counter()
    p.stdin.write(json.dumps({"id": rnd + 1, "cmd": "build", "params": {"project_dir": proj, "cache_dir": cache, "sources": srcs}}) + "\n"); p.stdin.flush()
    r = recv()
    if not r["ok"]: print(r["error"], r["traceback"]); break
    res = r["result"]
    print(f"build {rnd}: {time.perf_counter()-t:.2f}s worker={res['seconds']}s parts={len(res['parts'])} changed={sum(x['changed'] for x in res['parts'])}")
    for s in res["sources"]: print("  source", s["source"], "err=", s["error"] and s["error"]["message"], "t=", s["seconds"], "parts", s["parts"])
    for x in res["parts"][:4]: print("   ", x["name"], x["color"], os.path.getsize(x["mesh"]), "bytes")
p.stdin.write(json.dumps({"id": 9, "cmd": "inspect", "params": {}}) + "\n"); p.stdin.flush()
r = recv(); print("inspect:", json.dumps(r["result"]["parts"][:2])[:400] if r["ok"] else r)
p.stdin.close(); p.wait()
