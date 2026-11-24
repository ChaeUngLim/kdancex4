// 개발 DB 전용 — 홍보 이미지 하루 횟수·지난 입력(SX-6.5(하루 횟수·생성 요청 API))이 빈 칸이 아니게 「오늘 만든 홍보 이미지」 2건을 넣는다.
//
// 무엇을 넣나: brad 대표가 자기 학원 수업 「살사 LA 입문」에서 만든 홍보 이미지 두 번.
//   ① 성공 — 칩 커플 · 열정적인 · 스튜디오 · 빨간 조명(계약 16 §4-7 예시 문장 그대로). 그림은 scripts/dev-demo-assets/promo-salsa-couple-red-light.jpg —
//      SX-6.4 가 무료 엔진(Cloudflare Workers AI FLUX.1 [schnell])으로 실제로 만든 그림(_workspace/evidence/SX-6.4/screens/live-flux-schnell.jpg)을 옮겨 왔다.
//      번역 기록(englishPrompt)도 그 실행 로그(logs/live-smoke-cloudflare.log)에 남은 문장 그대로다. 이 스크립트는 엔진을 다시 부르지 않는다.
//   ② 실패 — 칩 커플 · 우아한 · 무대 · 따뜻한 노을빛. 엔진 오류(PROVIDER_ERROR)로 끝나 횟수를 돌려받은 기록(I41 「실패하면 횟수를 돌려줘요」).
//   결과: 오늘 brad 는 3번 중 1번을 썼고(남은 2번), 지난 입력에 2건이 보인다.
// 진짜 경로로 만든다: POST /api/ai/promo-images(멱등 키 고정) → POST /api/internal/ai/jobs/{jobId}/result(내부 토큰).
//   에이전트 서버를 띄우지 않아도 되게, 맡기는 연결은 「받았다」고만 답하는 가짜를 쓰고 결과는 위 기록을 결과 경로로 보낸다.
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-promo-images.ts
//   두 번 돌려도 같은 결과 — 멱등 키가 고정이라 이미 만든 생성은 그대로 돌려받고(횟수 다시 차감 없음), 끝난 작업에 보낸 결과는 무시된다.
//   먼저 scripts/dev-demo-owner.ts(brad)가 있어야 한다.
import "dotenv/config";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb } from "../prisma/db";
import { getDeps } from "../lib/server/deps";
import { createPosterJobRoutes } from "../lib/server/services/poster-extraction-jobs";
import { createPromoImageRoutes, promoCreateResponseSchema, promoHistorySchema } from "../lib/server/services/promo-image-generations";
import { createStaffAuth } from "../lib/server/staff-auth";

const BASE = "http://localhost:3000";
const CLASS_TITLE = "살사 LA 입문";

/** SX-6.4 진짜 실행(logs/live-smoke-cloudflare.log)의 번역 기록 */
const RECORDED_PROMPT =
  "A couple passionately dancing salsa under red lights in a studio, a man and a woman facing each other in a social partner dance hold, salsa or bachata, full body shot with the dancers visible from head to toe, not ballet, not hip-hop, not any other dance style, no text, no letters, no words, no captions, no logos, no watermark";

const DEMOS = [
  {
    key: "dev-demo-promo-image-1",
    chips: { who: "커플", mood: "열정적인", place: "스튜디오", color: "빨간 조명" },
    sentence: "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습",
    autoConditionIds: ["genre_pose", "full_body"],
    outcome: "succeeded",
  },
  {
    key: "dev-demo-promo-image-2",
    chips: { who: "커플", mood: "우아한", place: "무대", color: "따뜻한 노을빛" },
    sentence: "커플이 무대에서 따뜻한 노을빛 아래 우아하게 살사를 추는 모습",
    autoConditionIds: ["genre_pose", "full_body"],
    outcome: "failed",
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

// brad 대표와 그의 수업 — 앱(Bearer)으로 부른다(앱 경로는 2단계 인증이 없다)
const [owner] = await q<{ user_id: string; class_id: string }>(
  `SELECT u.id AS user_id, c.id::text AS class_id FROM auth."user" u
     JOIN staff_accounts s ON s.auth_user_id = u.id
     JOIN academy_owners o ON o.staff_account_id = s.id
     JOIN classes c ON c.academy_id = o.academy_id AND c.title = $1
    WHERE u.username = 'brad' ORDER BY c.created_at LIMIT 1`,
  [CLASS_TITLE],
);
if (owner === undefined) throw new Error(`brad 학원에 「${CLASS_TITLE}」 수업이 없다 — scripts/dev-demo-owner.ts 를 먼저 돌린다`);

const getSession = (h: Headers) => auth.api.getSession({ headers: h });
const token = (await ctx.internalAdapter.createSession(owner.user_id)).token;
const bearer = { authorization: `Bearer ${token}` };
// 「받았다」고만 답하는 맡기기 — 결과는 아래에서 기록을 보낸다
const promo = createPromoImageRoutes({ db, getSession, dispatchJob: async () => true });
const jobs = createPosterJobRoutes({ db, fileStorage: getDeps().fileStorage });
const image = await readFile(join(import.meta.dirname, "dev-demo-assets", "promo-salsa-couple-red-light.jpg"));

for (const demo of DEMOS) {
  const res = await promo.create(
    new Request(`${BASE}/api/ai/promo-images`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json", "Idempotency-Key": demo.key },
      body: JSON.stringify({ classId: owner.class_id, chips: demo.chips, sentence: demo.sentence, autoConditionIds: demo.autoConditionIds }),
    }),
    undefined,
  );
  if (res.status !== 202 && res.status !== 200) throw new Error(`만들기 요청 실패: ${res.status} ${await res.text()}`);
  const made = promoCreateResponseSchema.parse(await res.json());
  if (res.status === 200 || made.status === "succeeded" || made.status === "failed") {
    console.log(`이미 있다: 홍보 이미지 ${made.generationId} (${made.status})`);
    continue;
  }
  const [job] = await q<{ job_id: string }>("SELECT job_id::text AS job_id FROM promo_image_generations WHERE id = $1", [made.generationId]);
  const result =
    demo.outcome === "succeeded"
      ? {
          status: "succeeded",
          result: {
            englishPrompt: RECORDED_PROMPT,
            image: { contentType: "image/jpeg", base64: image.toString("base64") },
            engine: "cloudflare_flux_schnell",
            model: "@cf/black-forest-labs/flux-1-schnell",
            elapsedMs: 8000,
          },
        }
      : { status: "failed", error: { code: "PROVIDER_ERROR", message: "엔진 오류(시연)" } };
  const sent = await jobs.result(
    new Request(`${BASE}/api/internal/ai/jobs/${job!.job_id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Internal-Token": internalToken },
      body: JSON.stringify(result),
    }),
    { params: Promise.resolve({ jobId: job!.job_id }) },
  );
  if (sent.status !== 200) throw new Error(`결과 전달 실패: ${sent.status} ${await sent.text()}`);
  console.log(`넣음: 홍보 이미지 ${made.generationId} · ${demo.outcome}`);
}

// 지금 상태 요약 — 지난 입력과 오늘 남은 횟수
const hist = await promo.history(new Request(`${BASE}/api/ai/promo-images/history`, { headers: bearer }), undefined);
const items = promoHistorySchema.parse(await hist.json()).items;
for (const i of items) console.log(`지난 입력: ${i.createdOn} · ${i.status} · ${i.sentence}`);
const [use] = await q<{ used: number }>(
  `SELECT COALESCE(sum(u.used_count), 0)::int AS used FROM promo_image_usage u JOIN staff_accounts s ON s.id = u.staff_account_id
     JOIN auth."user" au ON au.id = s.auth_user_id WHERE au.username = 'brad' AND u.usage_date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
);
console.log(`brad 오늘 쓴 횟수: ${use?.used ?? 0} / 3`);
await db.close();
await pool.end();
