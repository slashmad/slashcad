"""Tiny local server for the WebGL bench: serves this directory and /model, collects POST /result.

Usage: python server.py <port> <model.glb> <results.jsonl>
Binds 127.0.0.1 only.
"""
import http.server
import json
import os
import sys
import urllib.parse

port, model, results = int(sys.argv[1]), sys.argv[2], sys.argv[3]
root = os.path.dirname(os.path.abspath(__file__))


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=root, **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.split("?")[0] == "/model.glb":
            with open(model, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        rec = json.loads(body)
        rec["engine"] = q.get("engine", ["?"])[0]
        with open(results, "a") as f:
            f.write(json.dumps(rec) + "\n")
        self.send_response(204)
        self.end_headers()


http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
