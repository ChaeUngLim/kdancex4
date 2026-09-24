"""에이전트 1회 = Planner(짧은 JSON) → Writer(답변) 두 번의 순차 호출을 N명이 동시에 보낸다.

사용법: python3 bench_pipeline.py <base_url> <동시수>
  - llama-server : http://localhost:11436
  - Ollama       : http://localhost:11434  (model 필드·reasoning_effort=none 을 함께 보낸다)
출력: first_visible(첫 글자가 보이기까지) · done(답변 완료) 의 p50·p95, 한자 섞인 답변 수.
2026-09-24 측정값은 specs/001-ai-dance-class-platform/local-ai-capacity.md 에 있다.
"""
import json, sys, threading, time, urllib.request
BASE, N = sys.argv[1], int(sys.argv[2])
CANDS = "\n".join(f"{i}. {g} {d} {t} {lv}({ins} 강사) 잔여 리드{i%5}/팔로우{(i*3)%7} 수강료 {15000+i*1000}원 장소 {loc}"
  for i,(g,d,t,lv,ins,loc) in enumerate([("살사","토","17:00","초급","리나","강남 라틴바"),("바차타","토","20:00","중급","Luis","역삼 바차타룸"),
  ("린디합","토","18:00","초급","민수","신사 스윙홀"),("탱고","일","15:00","입문","소라","강남 탱고살롱"),("룸바","토","09:00","고급","아이유","서초 댄스스포츠")]*6))
def call(content, max_tokens):
    body=json.dumps({"model":"qwen3.5:9b","messages":[{"role":"user","content":content}],"stream":True,"max_tokens":max_tokens,"temperature":0.2,"reasoning_effort":"none",
      "chat_template_kwargs":{"enable_thinking":False}}).encode()
    req=urllib.request.Request(f"{BASE}/v1/chat/completions",data=body,headers={"Content-Type":"application/json"})
    t0=time.perf_counter(); ttft=None; out=[]
    with urllib.request.urlopen(req,timeout=600) as r:
        for raw in r:
            l=raw.decode().strip()
            if l.startswith("data:") and not l.endswith("[DONE]"):
                p=(json.loads(l[5:]).get("choices") or [{}])[0].get("delta",{}).get("content") or ""
                if p:
                    ttft = ttft or time.perf_counter()-t0; out.append(p)
    return ttft, "".join(out)
res=[]
def user(i):
    t0=time.perf_counter()
    _,plan=call(f"한국어로만. 다음 요청을 검색 조건 JSON(요일,지역,장르,레벨,역할,이후활동)으로만 출력: 이번 주 토요일 강남에서 초급 살사 듣고 파티 가고 싶어 (사용자{i})",80)
    t_plan=time.perf_counter()-t0
    ttft,ans=call(f"한국어로만 답한다. 후보에 없는 수업을 지어내지 마라.\n[조건]{plan}\n[후보]\n{CANDS}\n추천 1~2개와 이유를 3문장 이내로.",220)
    res.append({"first_visible":t_plan+ttft,"done":time.perf_counter()-t0,"cjk":any('一'<=c<='鿿' for c in ans)})
ts=[threading.Thread(target=user,args=(i,)) for i in range(N)]
[t.start() for t in ts]; [t.join() for t in ts]
fv=sorted(r["first_visible"] for r in res); dn=sorted(r["done"] for r in res)
q=lambda v,p: round(v[min(len(v)-1,int(round(p*(len(v)-1))))],2)
print(json.dumps({"users":N,"prompt_chars":len(CANDS),"first_visible_p50":q(fv,.5),"first_visible_p95":q(fv,.95),"done_p50":q(dn,.5),"done_p95":q(dn,.95),"cjk_answers":sum(r["cjk"] for r in res)}))
