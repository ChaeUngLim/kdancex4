// 개발 DB 전용 — 앱 「홍보 이미지 · 소개 문구」 화면(SX-6.9(앱 홍보 이미지·소개 문구 화면), 보드 I32·I32B·I32C·I32D·I41·I42·I43)이
// 빈 칸이 아니게 「등록 마지막 단계에 있는 임시 저장 수업」 두 개를 넣는다.
//
// 무엇을 넣나(brad 학원 「브래드 댄스 스튜디오」의 수업 등록 위임 강사 둘):
//   ① 강다온 — 수업 「바차타(입문) · 2월」(월·수 20:30–21:30 · 2027-02-01~03-24 16회 · 300,000원 · 입문 · 남녀 6명씩), 임시 저장.
//      오늘 홍보 이미지 1장(칩 커플 · 열정적인 · 스튜디오 · 빨간 조명). 소개 문구 초안 1건(강조할 점 「처음 오는 분도 파트너 없이 신청할 수 있어요」)을
//      진짜 대화 모델(kdance-llm)로 만들어 홍보 자료에 「검토 전」으로 저장 → 앱 I32(검토·고치기) · I32D(소개 문구) 장면
//   ② 문하율 — 수업 「살사(초급) · 2월」(화·목 20:00–21:00 · 2027-02-02~03-25 16회 · 280,000원 · 초급 · 남녀 6명씩), 임시 저장.
//      오늘 홍보 이미지 3장 → 오늘 횟수 3/3 을 다 씀 → 앱 I42(오늘 다 씀) 장면
// 그림은 scripts/dev-demo-assets/promo-salsa-couple-red-light.jpg — SX-6.4 가 무료 엔진(Cloudflare Workers AI FLUX.1 [schnell])으로
//   실제로 만든 그림이다. 이 스크립트는 엔진을 다시 부르지 않는다(결과 경로에 그 그림을 보낸다).
// 진짜 경로로 만든다: 수업 POST /api/classes · 이미지 POST /api/ai/promo-images → 내부 결과 경로 · 초안 POST /api/ai/class-intro-drafts ·
//   저장 PUT /api/classes/{id}/promo-assets — 모두 서비스 처리기를 부른다. 행을 SQL 로 직접 넣지 않는다.
//
// 실행: cd admin-web && [AGENT_SERVER_URL=http://localhost:8100 AGENT_API_TOKEN=…] ./node_modules/.bin/jiti scripts/dev-demo-promo-screen.ts
//   에이전트 주소가 없으면 소개 문구 초안만 건너뛴다(화면은 「아직 소개 문구가 없어요」).
//   두 번 돌려도 같은 결과 — 수업·이미지는 멱등 키로 다시 찾고, 초안은 같은 수업·같은 강조할 점이 있으면 건너뛴다.
//   주의: 하루 횟수는 「만든 날(KST)」에 붙는다. 다른 날 다시 돌리면 이미 만든 생성을 돌려받을 뿐이라 그날 횟수는 3/3 그대로다.
//   먼저 scripts/dev-demo-owner.ts(brad)와 강사 시연 데이터(dev-demo-record-approvals.ts)가 있어야 한다.
import "dotenv/config";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb } from "../prisma/db";
import { agentIntroClientFromEnv } from "../lib/server/ai/agent-intro-client";
import { getDeps } from "../lib/server/deps";
import { createClassIntroDraftRoute, introDraftResponseSchema } from "../lib/server/services/class-intro-drafts";
import { createClassPromoAssetsRoutes, promoAssetsResponseSchema } from "../lib/server/services/class-promo-assets";
import { classRegistrationSchema, createClassRegistrationRoutes } from "../lib/server/services/class-registration";
import { createPosterJobRoutes } from "../lib/server/services/poster-extraction-jobs";
import { createPromoImageRoutes, promoCreateResponseSchema } from "../lib/server/services/promo-image-generations";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";
const EMPHASIS = "처음 오는 분도 파트너 없이 신청할 수 있어요";
/** SX-6.4 진짜 실행(logs/live-smoke-cloudflare.log)의 번역 기록 — dev-demo-promo-images.ts 와 같은 문장 */
const RECORDED_PROMPT =
  "A couple passionately dancing salsa under red lights in a studio, a man and a woman facing each other in a social partner dance hold, salsa or bachata, full body shot with the dancers visible from head to toe, not ballet, not hip-hop, not any other dance style, no text, no letters, no words, no captions, no logos, no watermark";

const DEMOS = [
  {
    username: "haneulpmd82",
    classKey: "dev-demo-promo-screen-class-1",
    cls: {
      title: "바차타(입문) · 2월",
      subGenre: "bachata",
      targetLevel: "entry",
      priceAmount: 300000,
      schedule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2027-02-01", periodTo: "2027-03-24" },
    },
    images: [
      {
        key: "dev-demo-promo-screen-image-1",
        chips: { who: "커플", mood: "열정적인", place: "스튜디오", color: "빨간 조명" },
        sentence: "커플이 스튜디오에서 빨간 조명 아래 열정적으로 바차타를 추는 모습",
      },
    ],
    intro: true,
  },
  {
    username: "haneulp0wb1",
    classKey: "dev-demo-promo-screen-class-2",
    cls: {
      title: "살사(초급) · 2월",
      subGenre: "salsa",
      targetLevel: "beginner",
      priceAmount: 280000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:00", endTime: "21:00", periodFrom: "2027-02-02", periodTo: "2027-03-25" },
    },
    images: [1, 2, 3].map((n) => ({
      key: `dev-demo-promo-screen-image-2-${n}`,
      chips: { who: "커플", mood: n === 2 ? "로맨틱한" : "열정적인", place: n === 3 ? "파티 홀" : "스튜디오", color: "빨간 조명" },
      sentence: `커플이 ${n === 3 ? "파티 홀" : "스튜디오"}에서 빨간 조명 아래 ${n === 2 ? "로맨틱하게" : "열정적으로"} 살사를 추는 모습`,
    })),
    intro: false,
  },
] as const;

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const internalToken = process.env["INTERNAL_API_TOKEN"] ?? "";
if (internalToken.trim() === "") throw new Error("INTERNAL_API_TOKEN 이 .env 에 없다 — 결과 전달 경로를 부를 수 없다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);
const getSession = (h: Headers) => auth.api.getSession({ headers: h });

const classes = createClassRegistrationRoutes({ db, getSession });
const promo = createPromoImageRoutes({ db, getSession, dispatchJob: async () => true }); // 「받았다」고만 답하고 결과는 아래에서 보낸다
const jobs = createPosterJobRoutes({ db, fileStorage: getDeps().fileStorage });
const promoAssets = createClassPromoAssetsRoutes({ db, getSession });
const introRoute = createClassIntroDraftRoute({ db, getSession, writeIntro: agentIntroClientFromEnv() });
const hasAgent = (process.env["AGENT_SERVER_URL"] ?? "").trim() !== "" && (process.env["AGENT_API_TOKEN"] ?? "").trim() !== "";
const image = await readFile(join(import.meta.dirname, "dev-demo-assets", "promo-salsa-couple-red-light.jpg"));

for (const demo of DEMOS) {
  // 강사와 그의 brad 학원 소속 · 첫 홀(수업 등록 위임이 있어야 한다)
  const [who] = await q<{ user_id: string; display_name: string; academy_id: string; room_id: string }>(
    `SELECT u.id AS user_id, s.display_name, a.academy_id::text AS academy_id,
            (SELECT r.id::text FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
              WHERE b.academy_id = a.academy_id AND r.status = 'active' ORDER BY r.name, r.id LIMIT 1) AS room_id
       FROM auth."user" u JOIN staff_accounts s ON s.auth_user_id = u.id
       JOIN instructor_affiliations a ON a.instructor_account_id = s.id AND a.status = 'active'
      WHERE u.username = $1
        AND EXISTS (SELECT 1 FROM instructor_delegations d WHERE d.affiliation_id = a.id AND d.permission = 'class_submit')
      LIMIT 1`,
    [demo.username],
  );
  if (who === undefined) throw new Error(`${demo.username}: 수업 등록 위임을 받은 소속이 없다 — 강사 시연 데이터를 먼저 넣는다`);
  const token = (await ctx.internalAdapter.createSession(who.user_id)).token;
  const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // 수업 임시 저장 — 멱등 키로 이미 만든 수업을 찾으면 읽기만(겹침 판정이 멱등 키보다 먼저라 다시 만들면 자기 수업과 겹친다)
  const [existing] = await q<{ id: string }>(
    `SELECT c.id::text AS id FROM classes c JOIN staff_accounts s ON s.id = c.created_by_account_id
      WHERE s.auth_user_id = $1 AND c.idempotency_key = $2`,
    [who.user_id, demo.classKey],
  );
  const res =
    existing !== undefined
      ? await classes.read(new Request(`${BASE}/api/classes/${existing.id}`, { headers: bearer }), { params: Promise.resolve({ classId: existing.id }) })
      : await classes.create(
          new Request(`${BASE}/api/classes`, {
            method: "POST",
            headers: { ...bearer, "Idempotency-Key": demo.classKey },
            body: JSON.stringify({
              academyId: who.academy_id,
              classKind: "regular",
              title: demo.cls.title,
              genre: "salsa_bachata",
              subGenre: demo.cls.subGenre,
              discipline: null,
              targetLevel: demo.cls.targetLevel,
              targetAges: ["all"],
              roomId: who.room_id,
              priceAmount: demo.cls.priceAmount,
              schedule: demo.cls.schedule,
              capacity: { mode: "gender_split", male: 6, female: 6 },
              refundDeadlineOn: null,
              introText: null,
            }),
          }),
          undefined,
        );
  if (res.status !== 201 && res.status !== 200) throw new Error(`수업 임시 저장 실패(${demo.username}): ${res.status} ${await res.text()}`);
  const cls = classRegistrationSchema.parse(await res.json());
  console.log(`수업: ${cls.title} (${cls.classId}) · ${cls.status} · 강사 ${who.display_name}`);

  // 홍보 이미지 — 진짜 만들기 경로(횟수 차감) → 기록된 결과를 결과 경로로
  let lastGenerationId: string | null = null;
  for (const img of demo.images) {
    const made = await promo.create(
      new Request(`${BASE}/api/ai/promo-images`, {
        method: "POST",
        headers: { ...bearer, "Idempotency-Key": img.key },
        body: JSON.stringify({ classId: cls.classId, chips: img.chips, sentence: img.sentence, autoConditionIds: ["genre_pose", "full_body"] }),
      }),
      undefined,
    );
    if (made.status !== 202 && made.status !== 200) throw new Error(`홍보 이미지 요청 실패: ${made.status} ${await made.text()}`);
    const body = promoCreateResponseSchema.parse(await made.json());
    lastGenerationId = body.generationId;
    if (body.status !== "queued" && body.status !== "running") {
      console.log(`  이미 있다: 홍보 이미지 ${body.generationId} (${body.status})`);
      continue;
    }
    const [job] = await q<{ job_id: string }>("SELECT job_id::text AS job_id FROM promo_image_generations WHERE id = $1", [body.generationId]);
    const sent = await jobs.result(
      new Request(`${BASE}/api/internal/ai/jobs/${job!.job_id}/result`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Internal-Token": internalToken },
        body: JSON.stringify({
          status: "succeeded",
          result: {
            englishPrompt: RECORDED_PROMPT,
            image: { contentType: "image/jpeg", base64: image.toString("base64") },
            engine: "cloudflare_flux_schnell",
            model: "@cf/black-forest-labs/flux-1-schnell",
            elapsedMs: 8000,
          },
        }),
      }),
      { params: Promise.resolve({ jobId: job!.job_id }) },
    );
    if (sent.status !== 200) throw new Error(`결과 전달 실패: ${sent.status} ${await sent.text()}`);
    console.log(`  넣음: 홍보 이미지 ${body.generationId} · 남은 횟수 ${body.remaining}`);
  }

  // 소개 문구 초안(①만) — 같은 수업 · 같은 강조할 점이 이미 있으면 모델을 다시 부르지 않는다
  if (demo.intro) {
    const [draft] = await q<{ id: string; body: string }>(
      "SELECT id::text AS id, body FROM class_intro_drafts WHERE class_id = $1::uuid AND emphasis = $2 ORDER BY created_at LIMIT 1",
      [cls.classId, EMPHASIS],
    );
    let introDraft = draft ?? null;
    if (introDraft === null && hasAgent) {
      const r = await introRoute(
        new Request(`${BASE}/api/ai/class-intro-drafts`, { method: "POST", headers: bearer, body: JSON.stringify({ classId: cls.classId, emphasis: EMPHASIS }) }),
        undefined,
      );
      if (r.status !== 200) throw new Error(`소개 문구 초안 실패: ${r.status} ${await r.text()}`);
      const made = introDraftResponseSchema.parse(await r.json());
      introDraft = { id: made.draftId, body: made.body };
      console.log(`  넣음: 소개 문구 초안 → ${made.body}`);
    } else if (introDraft === null) {
      console.log("  건너뜀: 소개 문구 초안(AGENT_SERVER_URL · AGENT_API_TOKEN 없음)");
    } else {
      console.log(`  이미 있다: 소개 문구 초안 → ${introDraft.body}`);
    }
    // 홍보 자료 — 아직 임시 저장일 때만, 검토 전으로(검토 확인은 앱의 「검토 끝 · 수업 등록」이 한다)
    if (cls.status === "draft") {
      const saved = await promoAssets.save(
        new Request(`${BASE}/api/classes/${cls.classId}/promo-assets`, {
          method: "PUT",
          headers: bearer,
          body: JSON.stringify({
            aiImageGenerationId: lastGenerationId,
            introText: introDraft?.body ?? null,
            introSource: introDraft === null ? null : "ai",
            introDraftId: introDraft?.id ?? null,
            reviewConfirmed: false,
          }),
        }),
        { params: Promise.resolve({ classId: cls.classId }) },
      );
      if (saved.status !== 200) throw new Error(`홍보 자료 저장 실패: ${saved.status} ${await saved.text()}`);
      const a = promoAssetsResponseSchema.parse(await saved.json());
      console.log(`  홍보 자료: 표지 ${a.coverSource} · 문구 ${a.introSource ?? "없음"} · 검토 ${a.reviewedAt === null ? "전" : "됨"}`);
    }
  }

  const [use] = await q<{ used: number }>(
    `SELECT COALESCE(sum(u.used_count), 0)::int AS used FROM promo_image_usage u JOIN staff_accounts s ON s.id = u.staff_account_id
       JOIN auth."user" au ON au.id = s.auth_user_id WHERE au.username = $1 AND u.usage_date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
    [demo.username],
  );
  console.log(`  ${who.display_name} 오늘 쓴 횟수: ${use?.used ?? 0} / 3`);
}

await db.close();
await pool.end();
