"""동시 사용자 N명이 AI 에이전트에 질문할 때의 첫 토큰 시간(TTFT)·완료 시간을 잰다.

사용법: python3 bench.py <base_url> <동시수> [출력토큰=220]
에이전트 1단계(Writer 한 번)에 해당하는 부하를 흉내 낸다 — 약 450토큰 맥락 + 220토큰 생성.
"""
import json
import statistics
import sys
import threading
import time
import urllib.request

BASE = sys.argv[1]
N = int(sys.argv[2])
NUM_PREDICT = int(sys.argv[3]) if len(sys.argv) > 3 else 220
API = sys.argv[4] if len(sys.argv) > 4 else "ollama"

CONTEXT = (
    "당신은 K-소셜댄스 수업 추천 도우미다. 반드시 한국어로만 답한다.\n"
    "[후보 수업]\n"
    "1. 강남 라틴바 토 17:00 초급 살사(리나 강사) 정원 리드12/팔로우12 잔여 리드2/팔로우6 수강료 20000원\n"
    "2. 강남 라틴바 토 19:00 소셜 파티 입장료 카드12000원/현금10000원\n"
    "3. 신사 스윙홀 토 18:00 초급 린디합(민수 강사) 잔여 리드0/팔로우3 수강료 25000원\n"
    "4. 역삼 바차타룸 토 20:00 중급 바차타(Luis 강사) 워크숍 20000원 잔여 리드4/팔로우1\n"
    "5. 강남 탱고살롱 일 15:00 입문 아르헨티나 탱고(소라 강사) 잔여 리드5/팔로우5 수강료 18000원\n"
    "[사용자 조건] 이번 주 토요일 강남, 초급 살사, 끝나고 파티까지, 역할 팔로우, 이동 30분 이내\n"
    "[규칙] 후보에 없는 수업을 지어내지 말 것. 금액·시각은 후보 값을 그대로 쓸 것. 추천 이유를 2문장으로.\n"
)


def one_openai(idx: int, out: list) -> None:
    """llama-server 의 OpenAI 호환 경로(/v1/chat/completions) 용."""
    body = json.dumps({
        "messages": [{"role": "user", "content": CONTEXT + f"\n질문 {idx}: 토요일 일정을 추천해줘."}],
        "stream": True, "max_tokens": NUM_PREDICT, "temperature": 0.3,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(f"{BASE}/v1/chat/completions", data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    ttft, tokens, text = None, 0, []
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw in resp:
                line = raw.decode().strip()
                if not line.startswith("data:") or line.endswith("[DONE]"):
                    continue
                d = json.loads(line[5:])
                piece = (d.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
                if piece:
                    if ttft is None:
                        ttft = time.perf_counter() - t0
                    tokens += 1
                    text.append(piece)
        out.append({"ttft": ttft, "total": time.perf_counter() - t0, "tokens": tokens, "text": "".join(text)})
    except Exception as e:
        out.append({"error": repr(e), "total": time.perf_counter() - t0})


def one(idx: int, out: list) -> None:
    if API == "openai":
        return one_openai(idx, out)
    body = json.dumps({
        "model": "qwen3.5:9b",
        "messages": [{"role": "user", "content": CONTEXT + f"\n질문 {idx}: 토요일 일정을 추천해줘."}],
        "stream": True,
        "think": False,
        "options": {"num_predict": NUM_PREDICT, "temperature": 0.3},
    }).encode()
    req = urllib.request.Request(f"{BASE}/api/chat", data=body, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    ttft = None
    tokens = 0
    text = []
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            for line in resp:
                d = json.loads(line)
                piece = d.get("message", {}).get("content", "")
                if piece and ttft is None:
                    ttft = time.perf_counter() - t0
                text.append(piece)
                if d.get("done"):
                    tokens = d.get("eval_count", 0)
        out.append({"ttft": ttft, "total": time.perf_counter() - t0, "tokens": tokens, "text": "".join(text)})
    except Exception as e:  # 과부하 거부(503) 등도 결과로 남긴다
        out.append({"error": repr(e), "total": time.perf_counter() - t0})


def main() -> None:
    results: list = []
    threads = [threading.Thread(target=one, args=(i, results)) for i in range(N)]
    wall0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - wall0
    ok = [r for r in results if "error" not in r]
    ttfts = sorted(r["ttft"] for r in ok if r["ttft"] is not None)
    totals = sorted(r["total"] for r in ok)
    toks = sum(r["tokens"] for r in ok)
    cjk = sum(1 for r in ok if any("一" <= ch <= "鿿" for ch in r["text"]))

    def p(v, q):
        return v[min(len(v) - 1, int(round(q * (len(v) - 1))))] if v else None

    print(json.dumps({
        "concurrency": N, "ok": len(ok), "errors": len(results) - len(ok),
        "ttft_p50": round(p(ttfts, .5), 2) if ttfts else None,
        "ttft_p95": round(p(ttfts, .95), 2) if ttfts else None,
        "total_p50": round(p(totals, .5), 2) if totals else None,
        "total_p95": round(p(totals, .95), 2) if totals else None,
        "aggregate_tok_per_s": round(toks / wall, 1),
        "per_user_tok_per_s": round(statistics.mean(r["tokens"] / r["total"] for r in ok), 1) if ok else None,
        "answers_with_chinese_chars": cjk,
        "sample": ok[0]["text"][:160] if ok else None,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
