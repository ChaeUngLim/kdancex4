"""Penpot MCP(localhost:4401)에 직접 JSON-RPC 로 붙어 execute_code 를 돌린다.
사용: python3 pp.py a.js [b.js ...]  — 파일들을 이어 붙여 한 번에 실행한다.
30초 시간 초과가 나도 플러그인은 끝까지 실행한다. 그때는 재시도하지 않고,
서버 로그(PENPOT_LOG)에 그 작업의 응답이 찍힐 때까지 기다린 뒤 'timeout-but-finished' 를 찍는다.
"""
import json, os, re, sys, time, urllib.request

URL = "http://localhost:4401/mcp"
HEADERS = {"Content-Type": "application/json", "Accept": "application/json,text/event-stream"}
LOG = os.environ.get("PENPOT_LOG", "")
WAIT_LIMIT_SEC = 600


def post(body, sid=None):
    headers = dict(HEADERS)
    if sid:
        headers["mcp-session-id"] = sid
    req = urllib.request.Request(URL, json.dumps(body).encode(), headers)
    with urllib.request.urlopen(req, timeout=90) as res:
        return res.headers.get("mcp-session-id"), res.read().decode()


def run(code):
    sid, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "kdance", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    _, out = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": "execute_code", "arguments": {"code": code}}}, sid)
    texts = []
    for line in out.splitlines():
        if line.startswith("data:"):
            data = json.loads(line[5:])
            texts += [c.get("text", "") for c in data.get("result", {}).get("content", [])]
            if "error" in data:
                texts.append(str(data["error"]))
    return "\n".join(texts)


def wait_finished(task_id):
    """시간 초과된 작업이 플러그인에서 끝날 때까지 서버 로그를 본다."""
    if not (LOG and os.path.exists(LOG)):
        return False
    deadline = time.time() + WAIT_LIMIT_SEC
    while time.time() < deadline:
        log = open(LOG, errors="ignore").read()
        if f"unknown task ID: {task_id}" in log:
            return True
        # 이 작업을 보낸 뒤에 연결이 끊겼으면 응답은 오지 않는다 — 기다리지 않고 바로 포기한다
        sent = log.rfind(f"Sent task {task_id}")
        if sent >= 0 and "WebSocket connection closed" in log[sent:]:
            return False
        time.sleep(3)
    return False


if __name__ == "__main__":
    result = run("\n".join(open(f, encoding="utf-8").read() for f in sys.argv[1:]))
    m = re.search(r"Task ([0-9a-f-]+) timed out", result)
    if not m:
        print(result)
    elif wait_finished(m.group(1)):
        print("timeout-but-finished", m.group(1))
    else:
        print("timeout-unknown", m.group(1), "(로그를 못 봤다 — 재시도하지 말고 조회로 확인)")
