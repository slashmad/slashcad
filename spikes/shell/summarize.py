"""Print one line per engine from a bench results.jsonl."""
import json
import sys

for path in sys.argv[1:]:
    print("###", path)
    for line in open(path):
        r = json.loads(line)
        if "error" in r:
            print(f"{r['engine']:26} ERROR {r['error'][:200]}")
            continue
        print(f"{r['engine']:26} meshes={r['meshes']}->{r.get('draw_meshes', '-')} merge={r.get('merge_ms', '-')}ms "
              f"tris={r['tris']:>8} load={r['load_ms']:>5}ms edges={r['edges_ms']:>5}ms "
              f"first={r['first_frame_ms']:>7}ms fps={r['rAF_fps']:>5} p95={r['frame_p95_ms']:>6} p99={r['frame_p99_ms']:>6} "
              f">25ms={r['frames_over_25ms']}/{r['frames']} sync50={r['sync_render_p50_ms']} sync95={r['sync_render_p95_ms']} "
              f"canvas={r['canvas']} gpu={r['gpu'][:50]}")
