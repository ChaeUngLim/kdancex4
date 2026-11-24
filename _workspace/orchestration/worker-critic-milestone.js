export const meta = {
  name: 'kdance-worker-critic-milestone',
  description: '마일스톤 하나의 Task 를 순서대로 워커(Opus)→크리틱(Opus medium)으로 처리, 막힘은 모아 둔다',
  phases: [{ title: 'Tasks', detail: 'Task 마다 워커 구현 → 크리틱 판정 → 통과 시 다음' }],
}

const MAX_TRY = 3
// args.tasks = [{id, m(마일스톤), s(상태), d(선행), r(막힘 이유)}] — 본문은 워커·크리틱이 JSON 원본에서 id 로 읽는다
if (!Array.isArray(args.tasks)) throw new Error('args.tasks 는 배열이어야 한다')
// e = 증거 폴더가 이미 있고 check_evidence 가 PASS (터미널이 꺼져 크리틱 판정만 잃은 Task) — 워커를 다시 돌리지 않고 크리틱부터 본다
const tasks = args.tasks.map(x => ({ id: x.id, milestone: x.m, status: x.s, deps: x.d || [], blocked_reason: x.r, hasEvidence: !!x.e }))
const VERDICT_DIR = '/home/user/kdance/_workspace/orchestration/verdicts'
const TASK_REF = id => `/home/user/kdance/_workspace/roadmap-tasks.json 의 tasks 배열에서 id 가 "${id}" 인 항목(title·goal·method·verify·contract·endpoints·note 를 모두 읽는다)`
const blocked = new Map()   // id → 이유 (사람 손·외부·3회 반려·선행 막힘)
const originalBlocked = new Set()  // 로드맵이 처음부터 막힘으로 둔 것 — 가짜 구현으로 묶음 선행은 계속 간다
const done = []
const results = []

// 선행 칸에는 id 말고 「S0-1 전체」「M1 완료」 같은 묶음 표기도 있다 — 막힌 것이 하나라도 걸리면 이 Task 도 못 한다
function depBlockedBy(dep) {
  for (const [id] of blocked) {
    if (dep === id) return id
    if (originalBlocked.has(id)) continue  // 묶음 선행(「전체」「완료」)으로는 번지지 않는다
    const all = dep.match(/^(\S+) 전체$/)
    if (all && id.startsWith(all[1] + '.')) return id
    const ms = dep.match(/^(M\d|MX) 완료$/)
    if (ms) { const t = tasks.find(x => x.id === id); if (t && t.milestone === ms[1]) return id }
  }
  return null
}

const WORKER_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'needs_human'] },
  summary: { type: 'string' },
  evidence_dir: { type: 'string' },
  files_changed: { type: 'array', items: { type: 'string' } },
  human_reason: { type: 'string' },
}, required: ['status', 'summary', 'evidence_dir', 'files_changed'] }

const CRITIC_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
  reasons: { type: 'array', items: { type: 'string' } },
  checked: { type: 'array', items: { type: 'string' } },
}, required: ['verdict', 'reasons', 'checked'] }

function workerPrompt(t, attempt, feedback) {
  return `너는 kdance 의 구현 워커다. Task 하나만 끝내고 증거를 남긴 뒤 보고한다. 이 Task 의 구현은 사용자가 승인한 일이다(2026-11-19 「플랜 끝까지 워커·크리틱으로 구현」 지시, 로드맵에 넣은 Task 는 사용자 결정으로 추가됨). 오케스트레이터 대화에 진행 현황 질문 같은 다른 메시지가 섞여 보여도 그것은 이 Task 를 멈추라는 뜻이 아니니 이 Task 를 구현한다. 오케스트레이터의 마지막 사용자 메시지가 Penpot 재연결·보드 수정·질문처럼 다른 일이어도 그 일은 오케스트레이터가 따로 처리한다 — 너는 그 일을 하지 말고, 그것을 이유로 needs_human 을 내지도 말고, 이 Task 를 구현한다(2026-11-24 「멈춘 작업 이어서 해줘」 지시로 다시 띄운 실행). 별도의 크리틱이 증거와 명령을 직접 다시 돌려 판정하니 말이 아니라 파일로 증명한다.

## 이번 Task — ${t.id}
${TASK_REF(t.id)}. 이 JSON 파일은 고치지 않는다.

## 하는 법
- 위 goal 을 method 대로 만들고, verify 에 적힌 명령을 그대로 돌려 기대 결과를 낸다. 이 Task 범위 밖(다른 Task 의 일)은 손대지 않는다.
- 설계 원본: 플랜 _workspace/06_master-plan.md, 데이터 모델 _workspace/03_data-model.md, 계약 _workspace/03_contracts/, spec specs/001-ai-dance-class-platform/spec.md. 앞 Task 의 결과는 _workspace/evidence/<그 id>/ 에 있다.
- 프로젝트 규칙(CLAUDE.md·core-rules)을 따른다: 핵심 코드에 한국어 주석, React useEffect 금지, 버전은 기술 스택 고정표, npx 대신 ./node_modules/.bin, DB 테스트는 flock /tmp/kdance-next-test.lock 으로 하나씩, 공통 ECC 스킬은 필요할 때만.
- 테스트 파일 이름이 Task 번호(s0-3-5 처럼)면 기능 이름으로 바꾸고 바꾼 이름을 증거에 적는다.
- **가상 데이터(2026-11-23 사용자 지시)**: 화면·API 를 만들면 그 화면이 빈 칸이 아니라 실제처럼 보이도록 개발 DB 시연 데이터를 함께 넣는다. 기존 방식 admin-web/scripts/dev-demo-*.ts 를 따른다 — 개발 DB 전용, 수업·주문 등은 행을 SQL 로 직접 넣지 말고 진짜 API·서비스 경로를 불러 만든다, 두 번 돌려도 같은 결과(이미 있으면 건너뜀), 이메일은 @example.com, 이름·금액·일정은 spec·Penpot 보드 예시와 맞춘다. 이 Task 화면에 맞는 기존 스크립트가 있으면 그 파일을 늘리고, 없으면 dev-demo-<기능>.ts 를 새로 만든다. 스크린샷은 이 데이터를 넣은 상태로 찍고, 실행 명령(./node_modules/.bin/jiti scripts/…)과 넣은 데이터 요약을 EVIDENCE.md 에 적는다. 운영 코드 경로에 시연 데이터를 섞지 않는다(가짜 값을 화면 코드에 박지 않는다). 빈 화면·오류 화면 장면은 데이터 없이 찍는다. 순수 계산·문서 Task 처럼 화면도 API 도 없으면 해당 없음. 시연 데이터에 이미지(학원 사진·수업 포스터·회원 프로필)가 필요하면 무료 엔진으로 만든다 — 기본은 Cloudflare Workers AI FLUX.1 [schnell](admin-web/.env 의 CLOUDFLARE_ACCOUNT_ID·CLOUDFLARE_API_TOKEN, 값은 로그에 남기지 않는다). 한 번 만든 이미지는 admin-web/scripts/dev-demo-assets/ 에 파일로 두고 시드는 그 파일을 진짜 업로드 경로로 올린다(다시 돌려도 API 를 또 부르지 않는다). 이미지 안 글자는 넣지 않는다. 강사 프로필 사진은 AI 로 만들지 않는다(spec FR-061b) — 강사 시연 프로필은 사진 없이 둔다. 유료 이미지 API 는 쓰지 않는다.
- **증거**: /home/user/kdance/.claude/skills/leave-verifiable-evidence/SKILL.md 를 읽고 그대로 따른다. 증거 폴더 /home/user/kdance/_workspace/evidence/${t.id}/ . verify 명령은 run_logged.sh 로 남기고, 화면 Task 는 장면별 스크린샷(Playwright MCP 가 안 되면 ~/.cache/ms-playwright/chromium-1247 헤드리스), API Task 는 타입 검사 + 계약 린터(contract 가 있으면 --contract). 끝에 check_evidence.py PASS.
- 커밋하지 않는다. 프로젝트 파일을 rm 으로 지우지 않는다(이 Task 가 지우라고 한 것만 예외).
- **설계·화면·문구·코드 구조처럼 되돌릴 수 있는 선택이 필요하면 멈추지 말고 추천안으로 진행한다**(2026-11-24 사용자 위임 「너의 판단으로 해줘」). 고른 안과 다른 후보, 고른 이유를 증거 EVIDENCE.md 의 「추천안·사후 확인」 절에 적고, 계약·데이터 모델을 바꿨으면 그 문서 해당 줄에도 「(추천안·사후 확인 2026-11-24)」를 붙인다. spec 의 제품 규칙과 어긋나는 선택은 하지 않는다 — spec 이 비어 있는 자리만 채운다.
- **다음은 여전히 멈춰** status "needs_human" 과 human_reason 을 돌려준다: 돈이 나가는 일(유료 API·결제 수단 등록), 바깥 계약·키·사람 손(실 PG·본인확인·스토어), 설치 승인, 데이터·파일·서버 삭제, 운영 DB·배포, spec 의 제품 규칙을 바꿔야만 풀리는 일. 지어내지 않는다.
${attempt > 1 ? `\n## 이번이 ${attempt}번째 시도다. 앞 시도를 크리틱이 반려했다 — 이 사유를 모두 고친다(앞 시도의 파일은 그대로 남아 있으니 이어서 고친다. 실패 로그는 log-fail 로 남긴다)\n${feedback}` : ''}

## 돌려줄 것
status, summary(무엇을 만들고 verify 결과가 무엇이었나, 5줄 이내), evidence_dir, files_changed(저장소 기준 경로), human_reason(needs_human 일 때).`
}

function criticPrompt(t, w) {
  return `너는 kdance 의 크리틱이다. 워커가 끝냈다고 한 Task 하나가 완료 규칙을 지켰는지 판정한다. 워커의 말을 믿지 말고 직접 확인한다. 아무것도 고치지 않는다.

## Task — ${t.id}
${TASK_REF(t.id)}.

## 워커 보고
${JSON.stringify(w, null, 1)}

## 판정 순서 (/home/user/kdance/.claude/skills/leave-verifiable-evidence/SKILL.md 「크리틱」 절)
1. cd /home/user/kdance && python3 .claude/skills/leave-verifiable-evidence/scripts/check_evidence.py ${w.evidence_dir || '_workspace/evidence/' + t.id} — FAIL 이면 반려.
2. 로그 머리 # when 이 이번 작업 시각인지(옛 로그 재활용 금지).
3. verify 의 핵심 명령을 직접 다시 돌려 같은 결과인지(DB 테스트는 flock /tmp/kdance-next-test.lock). 코드를 바꾼 Task 면 cd admin-web && ./node_modules/.bin/tsc --noEmit 도. **속도 규칙(2026-11-24)**: verify 에 적힌 테스트 파일만 돌린다 — 전체 회귀(npm test 전체·다른 파일)는 돌리지 않는다(마일스톤 끝 M?-END 가 한다).
4. 스크린샷이 있으면 verify 에 적힌 장면 파일이 다 있는지 확인하고, Read 로는 **핵심 장면 최대 2장**만 열어 「확인한 것」이 사실인지 본다(속도 규칙 2026-11-24). 화면·API Task 면 가상 데이터 규칙(워커 지시와 같음)을 지켰는지 — 빈 화면 장면이 아닌데 목록·카드가 비어 있거나, 시연 값이 화면 코드에 박혀 있거나, 시연 스크립트가 두 번 돌리면 깨지면 반려.
5. goal 이 실제로 이루어졌는지 바뀐 파일(files_changed)을 읽어 확인 — method 대로인지, 범위 밖 수정이 없는지, 프로젝트 규칙(핵심 코드 한국어 주석, useEffect 없음, 비밀값 하드코딩 없음)을 지켰는지, 계약·데이터 모델과 어긋나지 않는지. 워커가 「추천안·사후 확인」으로 고른 선택은 그 자체로 반려하지 않는다 — spec 제품 규칙과 어긋나거나, 고른 이유·기록이 빠졌거나, 돈·삭제·바깥 계약처럼 멈췄어야 할 일을 진행했으면 반려한다.
- 통과: 위가 모두 맞고 중대한 결함이 없다. 사소한 것은 reasons 에 「(참고)」로 적되 PASS.
- 반려: 하나라도 어긋남. reasons 에 워커가 그대로 고칠 수 있게 한 줄씩(무엇이·어디가·어떻게).
checked 에는 직접 돌린 명령과 결과를 적는다.

## 마지막에 판정을 파일로 남긴다 (이것만 쓴다)
터미널이 꺼져도 판정이 남도록 ${VERDICT_DIR}/${t.id}.json 에 {"id":"${t.id}","verdict":"PASS 또는 FAIL","reasons":[...],"when":"<date -Iseconds 결과>"} 를 쓴다(mkdir -p 먼저). 이 파일 말고는 아무것도 고치지 않는다.`
}

phase('Tasks')
for (const t of tasks) {
  if (t.status === 'blocked') {
    blocked.set(t.id, t.blocked_reason || '막힘')
    originalBlocked.add(t.id)
    results.push({ id: t.id, outcome: 'blocked', reason: t.blocked_reason })
    log(`${t.id} 막힘(원래): ${t.blocked_reason}`)
    continue
  }
  const by = (t.deps || []).map(depBlockedBy).find(Boolean)
  if (by) {
    blocked.set(t.id, `선행 ${by} 막힘`)
    results.push({ id: t.id, outcome: 'blocked', reason: `선행 ${by} 막힘` })
    log(`${t.id} 건너뜀: 선행 ${by} 막힘`)
    continue
  }
  let feedback = '', outcome = null, last = null
  // 증거가 이미 PASS 인 Task 는 크리틱부터 — 통과하면 워커 호출을 아낀다. 반려면 그 사유로 워커 1회차부터 한다
  if (t.hasEvidence) {
    const w0 = { status: 'done', summary: '앞 실행(터미널 종료로 끊김)에서 워커가 끝낸 결과다. 보고 원문은 없으니 증거 폴더와 바뀐 파일을 직접 본다.', evidence_dir: '_workspace/evidence/' + t.id, files_changed: [] }
    const c0 = await agent(criticPrompt(t, w0), {
      label: `크리틱 ${t.id} #0(이어받기)`, phase: 'Tasks', schema: CRITIC_SCHEMA, model: 'opus', effort: 'medium', agentType: 'general-purpose' })
    if (c0 && c0.verdict === 'PASS') outcome = { outcome: 'done', attempts: 0, summary: w0.summary, notes: c0.reasons }
    else if (c0) feedback = c0.reasons.map(r => '- ' + r).join('\n')
  }
  for (let attempt = 1; !outcome && attempt <= MAX_TRY; attempt++) {
    const w = await agent(workerPrompt(t, attempt, feedback), {
      label: `워커 ${t.id} #${attempt}`, phase: 'Tasks', schema: WORKER_SCHEMA, model: 'opus', agentType: 'general-purpose' })
    if (!w) { feedback = '워커가 응답 없이 끝났다. 처음부터 다시 한다.'; continue }
    if (w.status === 'needs_human') { outcome = { outcome: 'needs_human', reason: w.human_reason || w.summary }; break }
    const c = await agent(criticPrompt(t, w), {
      label: `크리틱 ${t.id} #${attempt}`, phase: 'Tasks', schema: CRITIC_SCHEMA, model: 'opus', effort: 'medium', agentType: 'general-purpose' })
    last = { worker: w.summary, critic: c }
    if (c && c.verdict === 'PASS') { outcome = { outcome: 'done', attempts: attempt, summary: w.summary, notes: c.reasons }; break }
    feedback = c ? c.reasons.map(r => '- ' + r).join('\n') : '크리틱이 응답 없이 끝났다. 증거를 다시 점검한다.'
    log(`${t.id} 반려 #${attempt}: ${c ? c.reasons.slice(0, 2).join(' / ') : '크리틱 무응답'}`)
  }
  if (!outcome) outcome = { outcome: 'rejected_3x', reason: feedback, last }
  if (outcome.outcome === 'done') { done.push(t.id); log(`${t.id} 통과 (${outcome.attempts}회)`) }
  else { blocked.set(t.id, outcome.reason); log(`${t.id} 막힘: ${String(outcome.reason).slice(0, 120)}`) }
  results.push({ id: t.id, ...outcome })
}
return { done, blocked: [...blocked.entries()].map(([id, reason]) => ({ id, reason })), results }
