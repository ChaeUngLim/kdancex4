// 개발 DB 전용 — 앱 알림함(보드 M21)에 「곧 수업이 시작해요」(수업 전 알림, S7-1.7(수업 전 알림 작업))가 보이게 하는 시연 데이터.
//
// 무엇을 넣나:
//   이도윤(demo-activity@example.com)의 결제완료 수업 「바차타 센슈얼 입문」의 첫 회차(12/1(화) 20:00 KST) 알림 1건.
//   알림 행을 SQL 로 넣지 않는다 — 진짜 내부 작업 경로(POST /api/internal/jobs/notifications/pre-class)를
//   「그 회원이 고른 시점」(알림 설정 two_hours → 수업 2시간 전) 시계(asOf)로 한 번 부른다. 서버가 고르고, 만들고, 발송기에 넘긴다.
//   그 시각에 같은 창에 든 다른 시연 회원의 확정 예약이 있으면 그 회원 알림도 함께 생긴다 — 작업이 원래 그렇게 동작한다.
//
// 두 번 돌려도 같은 결과: 이도윤에게 그 회차 알림이 이미 있으면 경로를 부르지 않는다(불러도 열쇠가 같아 0건이다).
//
// 실행: cd admin-web && ./node_modules/.bin/jiti scripts/dev-demo-pre-class-reminder.ts
//   먼저 dev-demo-member-activity.ts(이도윤의 주문·결석) · dev-demo-notification-settings.ts(2시간 전)가 있어야 하고,
//   개발 서버(:3000, KDANCE_DEV_ROUTES=true)가 떠 있어야 한다(시험용 시계 asOf 는 dev 경로가 켜졌을 때만 받는다).
import "dotenv/config";

import type { PreClassLead } from "../lib/domain/constants";
// 시점 이름 → 몇 분 전 — 작업이 쓰는 표를 그대로 쓴다(값을 여기 다시 적지 않는다)
import { DEFAULT_PRE_CLASS_LEAD, PRE_CLASS_LEAD_MINUTES } from "../lib/domain/pre-class-reminder";
import { createDb } from "../prisma/db";

const BASE = process.env["DEMO_API_BASE"] ?? "http://localhost:3000";
const MEMBER_EMAIL = "demo-activity@example.com";
const CLASS_TITLE = "바차타 센슈얼 입문";

const url = process.env["DATABASE_URL"] ?? "";
// 운영·테스트 DB 에 실수로 넣지 않게 DB 이름을 먼저 본다
if (new URL(url).pathname !== "/kdance_next") throw new Error("개발 DB(kdance_next)에만 넣는다");
const internalToken = process.env["INTERNAL_API_TOKEN"];
if (!internalToken) throw new Error("INTERNAL_API_TOKEN 이 없다 — admin-web/.env 를 확인한다");

const { db, pool } = createDb(url, { poolMax: 2 });
const q = <T>(text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows as T[]);

async function finish(code = 0): Promise<never> {
  await db.close();
  await pool.end();
  process.exit(code);
}

// 이도윤의 그 수업 첫 회차(결석을 알리지 않은 예정 회차 중 가장 이른 것)와 알림 시점 — 읽기만 한다
const [target] = await q<{ member_id: string; session_id: string; starts_at: string; lead: string | null }>(
  `SELECT m.id AS member_id, s.id::text AS session_id,
          to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at, ns.pre_class_lead AS lead
     FROM auth."user" u
     JOIN members m ON m.auth_user_id = u.id
     JOIN reservations r ON r.member_id = m.id AND r.status = 'confirmed'
     JOIN orders o ON o.id = r.order_id AND o.status IN ('paid', 'partially_refunded')
     JOIN class_offerings co ON co.id = r.offering_id
     JOIN classes c ON c.id = co.class_id AND c.title = $2
     JOIN class_sessions s ON s.offering_id = r.offering_id AND s.status = 'scheduled'
     LEFT JOIN notification_settings ns ON ns.member_id = m.id
    WHERE u.email = $1
      AND NOT EXISTS (SELECT 1 FROM attendance_marks am
                       WHERE am.reservation_id = r.id AND am.session_id = s.id AND am.cancelled_at IS NULL)
    ORDER BY s.starts_at LIMIT 1`,
  [MEMBER_EMAIL, CLASS_TITLE],
);
if (target === undefined) {
  console.error(`${MEMBER_EMAIL} 의 「${CLASS_TITLE}」 확정 회차가 없다 — dev-demo-member-activity.ts 를 먼저 돌린다`);
  await finish(1);
}
const t = target!;
const lead = (t.lead ?? DEFAULT_PRE_CLASS_LEAD) as PreClassLead;

const existing = await q<{ id: string }>(
  "SELECT id::text FROM notifications WHERE kind = 'pre_class_reminder' AND recipient_member_id = $1 AND payload->>'sessionId' = $2",
  [t.member_id, t.session_id],
);
if (existing.length > 0) {
  console.log(`건너뜀: 이도윤의 ${t.starts_at} 회차 수업 전 알림이 이미 있다(${existing.length}건)`);
} else {
  // 그 회원이 고른 시점이 막 된 순간으로 시계를 맞춰 진짜 작업 경로를 부른다
  const asOf = new Date(new Date(t.starts_at).getTime() - PRE_CLASS_LEAD_MINUTES[lead] * 60_000).toISOString();
  const response = await fetch(`${BASE}/api/internal/jobs/notifications/pre-class`, {
    method: "POST",
    headers: { "X-Internal-Token": internalToken, "Content-Type": "application/json" },
    body: JSON.stringify({ asOf }),
  });
  const body = await response.text();
  if (response.status !== 200) {
    console.error(`작업 경로가 ${response.status} 를 돌려줬다: ${body}`);
    await finish(1);
  }
  console.log(`작업 실행: asOf ${asOf}(시점 ${lead}) → ${response.status} ${body}`);
}

const rows = await q<{ delivery_status: string; title: string; body: string; created_at: string }>(
  `SELECT delivery_status, payload->>'title' AS title, payload->>'body' AS body,
          to_char(created_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS created_at
     FROM notifications WHERE kind = 'pre_class_reminder' AND recipient_member_id = $1 ORDER BY created_at`,
  [t.member_id],
);
console.log(`이도윤 수업 전 알림 ${rows.length}건: ${rows.map((r) => `「${r.title}」 ${r.body} (${r.delivery_status}, ${r.created_at})`).join(" · ")}`);
await finish(0);
