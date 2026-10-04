#!/usr/bin/env bash
# 고품질(HQ) 카드를 한 장마다 서버를 새로 띄워 뽑는다 — 2026-10-03 실측: 한 프로세스에서 HQ 를 연달아 돌리면 2~3장째 CUDA OOM.
# 서버 로그는 $SP/local-sd-server-<실행ID>-<장르>.log (2026-10-03: 장르만 쓰면 같은 장르를 연달아 돌릴 때 앞 로그가 덮였다).
# 서버 PID 는 $! 로 받아 그 PID 만 죽인다(pgrep 자기 셸 사고 방지). PYTORCH_CUDA_ALLOC_CONF=expandable_segments 는 WSL 에서
# "CUDA driver error: out of memory" 를 내므로 쓰지 않는다.
#   [HR_LORA=0] bash docs/prototype/local-sd/hq_one_by_one.sh <style> <model> <lora_weight> <run> <genre> [genre ...]
#   HR_LORA 환경변수를 주면 1536 단계의 LoRA 세기를 따로 정한다(0 = 2단계에서 LoRA 끔).
#   2026-10-03 확정(C 설정): <lora_weight> 0 + HR_LORA=0.3 — 1단계는 LoRA 없이 체크포인트가 구도를 짜고, 2단계에서만 LoRA 가 얼굴·질감을 입힌다.
#   IP_ARGS="--ip-ref a.jpg --ip-ref b.jpg --ip-weight 0.6" 처럼 주면 IP-Adapter 옵션을 그대로 넘긴다.
set -u
STYLE=$1; MODEL=$2; LORA=$3; RUN=$4; shift 4
ROOT=/home/user/kdance; SD=$ROOT/docs/prototype/local-sd
SP=/tmp/claude-1000/-home-user-kdance/063de942-7297-4439-a677-ceb2c854f812/scratchpad
for G in "$@"; do
  echo "== $G: 서버 기동"
  ( cd "$SD" && exec .venv/bin/python server.py ) > "$SP/local-sd-server-$RUN-$G.log" 2>&1 &
  SRV=$!
  for i in $(seq 1 60); do sleep 1; curl -s --max-time 2 http://localhost:7860/health >/dev/null && break; done
  cd "$ROOT" && uv run --with pillow --python 3.12 docs/prototype/gen_genre_multi.py --style "$STYLE" --model "$MODEL" --only "$G" --lora-weight "$LORA" ${HR_LORA:+--hr-lora-weight $HR_LORA} ${IP_ARGS:-} --hq --run "$RUN" 2>&1 | grep -E "OK|실패|HTTP"
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
  for i in $(seq 1 20); do sleep 1; [ "$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)" -lt 600 ] && break; done
  echo "== $G: 서버 종료 · VRAM $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
done
echo "끝."
