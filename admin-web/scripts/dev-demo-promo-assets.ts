// 개발 DB 전용 — 검토 후 게시 경로(SX-6.7(검토 후 게시 경로))가 빈 칸이 아니게 「AI 표지를 검토하고 승인 요청한 수업」 1건을 넣는다.
//
// 무엇을 넣나: brad 학원에 소속돼 「수업 등록」 위임을 받은 살사/바차타 강사가 올린 수업 「살사 LA 입문 · 1월」.
//   ① 수업 임시 저장 — POST /api/classes(멱등 키 고정). 값은 「살사 LA 입문」과 같고(60,000원 · 입문 · 남녀 6명씩) 날짜만 1월 토요일 4회
//   ② 홍보 이미지 한 장 — POST /api/ai/promo-images(멱등 키 고정) → 결과 경로. 그림은 scripts/dev-demo-assets/promo-salsa-couple-red-light.jpg
//      (SX-6.4 가 무료 엔진 Cloudflare Workers AI FLUX.1 [schnell]로 실제로 만든 그림). 이 스크립트는 엔진을 다시 부르지 않는다.
//      강사의 오늘 홍보 이미지 횟수를 1 쓴다(두 번째 실행부터는 같은 생성을 돌려받아 다시 쓰지 않는다)
//   ③ PUT /api/classes/{id}/promo-assets — AI 표지 + 직접 쓴 소개 문구, 검토 확인 없이 저장
//   ④ 승인 요청 → 409 PROMO_REVIEW_REQUIRED(검토 없이 게시 못 함)를 한 번 보여 준다
//   ⑤ 검토 확인과 함께 다시 저장 → 승인 요청 200 → 「승인 대기」. 대표(brad)의 승인 화면에 AI 표지가 검토된 수업으로 보인다
// 진짜 경로로 만든다: 수업·이미지·홍보 자료·승인 요청 모두 서비스 처리기를 부른다. 행을 SQL 로 직접 넣지 않는다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-promo-assets.ts
//   두 번 돌려도 같은 결과 — 수업은 멱등 키로 찾아 다시 읽고 이미지는 멱등 키로 같은 것을 돌려받으며, 이미 승인 대기 이상이면 ③~⑤ 를 건너뛴다.
//   먼저 scripts/dev-demo-owner.ts(brad)와 강사 시연 데이터가 있어야 한다.
import "dotenv/config";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb } from "../prisma/db";
import { getDeps } from "../lib/server/deps";
import { createClassPromoAssetsRoutes, promoAssetsResponseSchema } from "../lib/server/services/class-promo-assets";
import { classRegistrationSchema, createClassRegistrationRoutes } from "../lib/server/services/class-registration";
import { createPosterJobRoutes } from "../lib/server/services/poster-extraction-jobs";
import { createPromoImageRoutes, promoCreateResponseSchema } from "../lib/server/services/promo-image-generations";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";
const CLASS_KEY = "dev-demo-promo-assets-class-1";
const IMAGE_KEY = "dev-demo-promo-assets-image-1";
const INTRO = "살사 LA 스타일 기본 스텝과 턴을 익혀요. 파트너 없이 와도 괜찮아요.";
/** SX-6.4 진짜 실행(logs/live-smoke-cloudflare.log)의 번역 기록 — dev-demo-promo-images.ts 와 같은 문장 */
const RECORDED_PROMPT =
  "A couple passionately dancing salsa under red lights in a studio, a man and a woman facing each other in a social partner dance hold, salsa or bachata, full body shot with the dancers visible from head to toe, not ballet, not hip-hop, not any other dance style, no text, no letters, no words, no captions, no logos, no watermark";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const internalToken = process.env["INTERNAL_API_TOKEN"] ?? "";
if (internalToken.trim() === "") throw new Error("INTERNAL_API_TOKEN 이 .env 에 없다 — 결과 전달 경로를 부를 수 없다");

const { db, pool } = createDb(url, { poolMax: 2 });
const auth = createStaffAuth({ pool, secret: process.env["BETTER_AUTH_SECRET"]!, baseURL: process.env["BETTER_AUTH_URL"]! });
const ctx = await auth.$context;
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

// 올리는 사람 — brad 학원의 「수업 등록」 위임 강사(강사 앱은 Bearer, 2단계 인증이 없다). dev-demo-poster-extraction.ts 와 같은 고르기
const [uploader] = await q<{ user_id: string; academy_id: string; room_id: string; display_name: string }>(
  `SELECT u.id AS user_id, a.academy_id::text AS academy_id, s.display_name,
          (SELECT r.id::text FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
            WHERE b.academy_id = a.academy_id AND r.status = 'active' ORDER BY r.name, r.id LIMIT 1) AS room_id
     FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN instructor_affiliations a ON a.instructor_account_id = s.id AND a.status = 'active'
     JOIN instructor_profiles p ON p.staff_account_id = s.id AND p.activity_genre = 'salsa_bachata'
     JOIN academy_owners o ON o.academy_id = a.academy_id JOIN staff_accounts os ON os.id = o.staff_account_id
     JOIN auth."user" ou ON ou.id = os.auth_user_id AND ou.username = 'brad'
    WHERE EXISTS (SELECT 1 FROM instructor_delegations d WHERE d.affiliation_id = a.id AND d.permission = 'class_submit')
    ORDER BY s.display_name, s.id LIMIT 1`,
);
if (uploader === undefined) throw new Error("brad 학원에 수업 등록 위임을 받은 살사/바차타 강사가 없다 — 강사 시연 데이터를 먼저 넣는다");

const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const token = (await ctx.internalAdapter.createSession(uploader.user_id)).token;
const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const classes = createClassRegistrationRoutes({ db, getSession });
const promoAssets = createClassPromoAssetsRoutes({ db, getSession });

// ① 수업 임시 저장(멱등 키 고정). 두 번째 실행에서는 일정 겹침 판정이 멱등 키보다 먼저라(자기 수업과 겹친다) 이미 만든 수업을 읽는다
const [existingClass] = await q<{ id: string }>(
  `SELECT c.id::text AS id FROM classes c JOIN staff_accounts s ON s.id = c.created_by_account_id
    WHERE s.auth_user_id = $1 AND c.idempotency_key = $2`,
  [uploader.user_id, CLASS_KEY],
);
const created =
  existingClass !== undefined
    ? await classes.read(new Request(`${BASE}/api/classes/${existingClass.id}`, { headers: bearer }), {
        params: Promise.resolve({ classId: existingClass.id }),
      })
    : await classes.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...bearer, "Idempotency-Key": CLASS_KEY },
        body: JSON.stringify({
          academyId: uploader.academy_id,
          classKind: "regular",
          title: "살사 LA 입문 · 1월",
          genre: "salsa_bachata",
          subGenre: "salsa",
          discipline: null,
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: uploader.room_id,
          priceAmount: 60000,
          schedule: { kind: "recurring", weekdays: ["sat"], startTime: "13:00", endTime: "14:00", periodFrom: "2027-01-09", periodTo: "2027-01-30" },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
        }),
      }),
      undefined,
    );
if (created.status !== 201 && created.status !== 200) throw new Error(`수업 임시 저장 실패: ${created.status} ${await created.text()}`);
const cls = classRegistrationSchema.parse(await created.json());
console.log(`수업: ${cls.title} (${cls.classId}) · ${cls.status} · 강사 ${uploader.display_name}`);

// ② 홍보 이미지 — 「받았다」고만 답하는 맡기기 + 기록된 결과를 결과 경로로
const promo = createPromoImageRoutes({ db, getSession, dispatchJob: async () => true });
const madeRes = await promo.create(
  new Request(`${BASE}/api/ai/promo-images`, {
    method: "POST",
    headers: { ...bearer, "Idempotency-Key": IMAGE_KEY },
    body: JSON.stringify({
      classId: cls.classId,
      chips: { who: "커플", mood: "열정적인", place: "스튜디오", color: "빨간 조명" },
      sentence: "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습",
      autoConditionIds: ["genre_pose", "full_body"],
    }),
  }),
  undefined,
);
if (madeRes.status !== 202 && madeRes.status !== 200) throw new Error(`홍보 이미지 요청 실패: ${madeRes.status} ${await madeRes.text()}`);
const made = promoCreateResponseSchema.parse(await madeRes.json());
if (made.status === "queued" || made.status === "running") {
  const image = await readFile(join(import.meta.dirname, "dev-demo-assets", "promo-salsa-couple-red-light.jpg"));
  const [job] = await q<{ job_id: string }>("SELECT job_id::text AS job_id FROM promo_image_generations WHERE id = $1", [made.generationId]);
  const sent = await createPosterJobRoutes({ db, fileStorage: getDeps().fileStorage }).result(
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
  console.log(`넣음: 홍보 이미지 ${made.generationId}`);
} else {
  console.log(`이미 있다: 홍보 이미지 ${made.generationId} (${made.status})`);
}

const putAssets = (reviewConfirmed: boolean) =>
  promoAssets.save(
    new Request(`${BASE}/api/classes/${cls.classId}/promo-assets`, {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ aiImageGenerationId: made.generationId, introText: INTRO, introSource: "user", reviewConfirmed }),
    }),
    { params: Promise.resolve({ classId: cls.classId }) },
  );
const submit = () =>
  classes.submit(new Request(`${BASE}/api/classes/${cls.classId}/submit`, { method: "POST", headers: bearer, body: "{}" }), {
    params: Promise.resolve({ classId: cls.classId }),
  });

// ③~⑤ 아직 임시 저장일 때만 — 이미 승인 대기 이상이면 건너뛴다(두 번 돌려도 같은 결과)
if (cls.status === "draft") {
  const unreviewed = await putAssets(false);
  if (unreviewed.status !== 200) throw new Error(`홍보 자료 저장 실패: ${unreviewed.status} ${await unreviewed.text()}`);
  const blocked = await submit();
  console.log(`검토 없이 승인 요청: ${blocked.status} ${((await blocked.json()) as { code?: string }).code ?? ""}`);
  if (blocked.status !== 409) throw new Error("검토 없는 승인 요청이 막히지 않았다");

  const reviewed = await putAssets(true);
  if (reviewed.status !== 200) throw new Error(`검토 확인 저장 실패: ${reviewed.status} ${await reviewed.text()}`);
  const passed = await submit();
  if (passed.status !== 200) throw new Error(`검토 뒤 승인 요청 실패: ${passed.status} ${await passed.text()}`);
  console.log("검토 확인 뒤 승인 요청: 200");
} else {
  console.log(`이미 ${cls.status} — 홍보 자료 저장·승인 요청을 건너뛴다`);
}

// 지금 상태 요약
const read = await promoAssets.read(new Request(`${BASE}/api/classes/${cls.classId}/promo-assets`, { headers: bearer }), {
  params: Promise.resolve({ classId: cls.classId }),
});
const assets = promoAssetsResponseSchema.parse(await read.json());
const [state] = await q<{ status: string }>("SELECT status FROM classes WHERE id = $1", [cls.classId]);
console.log(
  `요약: ${cls.title} · 수업 ${state?.status} · 표지 ${assets.coverSource}(${assets.coverUrl}) · 문구 ${assets.introSource} · ` +
    `AI ${assets.aiGenerated} · 검토 ${assets.reviewedAt === null ? "안 됨" : "됨"} · 글자 원본 ${assets.textOverlay.source}`,
);
// SX-6.8: 표지·문구 각각의 「AI 생성」 표시(FR-258) — 화면이 그대로 그릴 배지·안내 글
console.log(
  `AI 생성 표시: 표지 ${assets.aiMarks.cover === null ? "없음" : `${assets.aiMarks.cover.badge} · ${assets.aiMarks.cover.note}`} · ` +
    `문구 ${assets.aiMarks.intro === null ? "없음" : `${assets.aiMarks.intro.badge} · ${assets.aiMarks.intro.note}`}`,
);
await db.close();
await pool.end();
