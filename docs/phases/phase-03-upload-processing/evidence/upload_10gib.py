"""Evidência manual: upload de 10 GiB direto ao storage via URLs pré-assinadas.

Fluxo: registro → confirmação (Mailpit) → login → initiate → PUT das parts em
paralelo no SeaweedFS → complete → polling até ready. Durante o upload, outra
thread mede a latência de GET /videos/:shortId para mostrar que a API não trava.
"""
import json, re, sys, threading, time, uuid, statistics
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "http://localhost:3000"
MAILPIT = "http://localhost:8025"
FILE = sys.argv[1]
SIZE = 10 * 1024**3


def call(method, url, body=None, token=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=600) as r:
        text = r.read()
        return r.status, dict(r.headers), (json.loads(text) if text and r.headers.get("Content-Type", "").startswith("application/json") else text)


email = f"big-{uuid.uuid4().hex[:8]}@example.com"
password = "Str0ng!Passw0rd"
call("POST", f"{API}/auth/register", {"email": email, "password": password})
time.sleep(1)
msgs = call("GET", f"{MAILPIT}/api/v1/search?query=to:{email}")[2]
msg = call("GET", f"{MAILPIT}/api/v1/message/{msgs['messages'][0]['ID']}")[2]
token_conf = re.search(r"token=([A-Za-z0-9_\-\.%]+)", msg["Text"]).group(1)
call("GET", f"{API}/auth/confirm-email?token={token_conf}")
access = call("POST", f"{API}/auth/login", {"email": email, "password": password})[2]["access_token"]

st, _, init = call("POST", f"{API}/videos", {"file_name": "big-10gib.mp4", "mime_type": "video/mp4", "size": SIZE}, access)
short_id = init["video"]["short_id"]
part_size, part_count = init["upload"]["part_size"], init["upload"]["part_count"]
print(f"initiate {st}: short_id={short_id} part_size={part_size} part_count={part_count} status={init['video']['processing_status']}")

urls = {}
for i in range(0, part_count, 50):
    nums = list(range(i + 1, min(i + 50, part_count) + 1))
    for p in call("POST", f"{API}/videos/{short_id}/upload/part-urls", {"part_numbers": nums}, access)[2]["parts"]:
        urls[p["part_number"]] = p["url"]

latencies, stop = [], threading.Event()


def probe():
    while not stop.is_set():
        t = time.perf_counter()
        call("GET", f"{API}/videos/{short_id}", token=access)
        latencies.append((time.perf_counter() - t) * 1000)
        time.sleep(0.5)


def put(n):
    with open(FILE, "rb") as f:
        f.seek((n - 1) * part_size)
        chunk = f.read(part_size)
    _, headers, _ = call("PUT", urls[n], raw=chunk)
    return {"part_number": n, "etag": headers["ETag"]}


threading.Thread(target=probe, daemon=True).start()
t0 = time.time()
with ThreadPoolExecutor(max_workers=8) as ex:
    parts = list(ex.map(put, range(1, part_count + 1)))
upload_s = time.time() - t0
stop.set()
print(f"upload: {part_count} parts, {SIZE / 1024**3:.0f} GiB em {upload_s:.0f}s ({SIZE / upload_s / 1024**2:.0f} MiB/s)")
print(f"API durante o upload: {len(latencies)} GETs, mediana {statistics.median(latencies):.0f} ms, p95 {sorted(latencies)[int(len(latencies) * .95)]:.0f} ms, máx {max(latencies):.0f} ms")

st, _, done = call("POST", f"{API}/videos/{short_id}/upload/complete", {"parts": parts}, access)
print(f"complete {st}: status={done['processing_status']}")
t1 = time.time()
while True:
    v = call("GET", f"{API}/videos/{short_id}", token=access)[2]
    if v["processing_status"] in ("ready", "failed"):
        break
    time.sleep(2)
print(f"processamento: {v['processing_status']} em {time.time() - t1:.0f}s; " +
      ", ".join(f"{k}={v.get(k)}" for k in ("size_bytes", "duration_seconds", "width", "height", "video_codec", "audio_codec", "failure_reason", "thumbnail_url")))
pb = call("GET", f"{API}/videos/{short_id}/playback-url", token=access)[2]["url"]
st, h, body = call("GET", pb, headers={"Range": "bytes=0-1023"})
print(f"streaming: HTTP {st}, {len(body)} bytes, Content-Range={h.get('Content-Range')}")
dl = call("GET", f"{API}/videos/{short_id}/download-url", token=access)[2]["url"]
st, h, _ = call("GET", dl, headers={"Range": "bytes=0-0"})
print(f"download: HTTP {st}, Content-Disposition={h.get('Content-Disposition')}")
