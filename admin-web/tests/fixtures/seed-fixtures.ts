// S0-2.5(시드를 테스트 픽스처로) — 「학원 1 · 정규 수업 1 · 8회차 · 남 6 여 6」 표준 데이터 한 벌.
//
// 쓰는 곳 두 가지:
//   ① DB 테스트가 `insertSeedFixtures(pool)` 를 불러 같은 모양의 데이터에서 시작한다.
//   ② `npm run db:seed`(scripts/seed.ts)가 테스트 DB 에 같은 데이터를 넣어 눈으로 볼 수 있게 한다.
// 화면이 읽는 데이터가 아니다 — 실제 학원·수업은 S1-1·S2-2 가 만든다. 그래서 개발 DB(kdance_next)에는 넣지 않는다.
//
// 같은 코드를 여러 번 돌려도 같은 결과가 나오도록(멱등) id 를 고정하고 `ON CONFLICT DO NOTHING` 을 쓴다.
import type { Pool } from "pg";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "./academy-seller.ts";

/** 한 반의 성별 정원. 남·여 각 6명이라 자리 묶음 2개(male 6, female 6)가 생긴다. */
export const SEED_SEATS_PER_GENDER = 6;
/** 정규 수업의 회차 수. 매주 1회씩 8주. */
export const SEED_SESSION_COUNT = 8;

// 고정 id — 숫자만 바꿔 읽기 쉽게 만든 UUID 형식 값이다(자리 구분: 1=학원 2=수업 3=신청 단위 4=회차 5=자리 묶음 6=회원).
const uuid = (kind: number, n = 0) =>
  `00000000-0000-4000-8000-${String(kind).padStart(4, "0")}${String(n).padStart(8, "0")}`;

export const SEED_IDS = {
  academy: uuid(1),
  class: uuid(2),
  offering: uuid(3),
  session: (seq: number) => uuid(4, seq),
  seatPool: (kind: "male" | "female") => uuid(5, kind === "male" ? 1 : 2),
  member: (gender: "male" | "female", n: number) => uuid(6, (gender === "male" ? 0 : 100) + n),
} as const;

export type SeedSummary = {
  academyId: string;
  classId: string;
  offeringId: string;
  sessionIds: string[];
  seatPoolIds: { male: string; female: string };
  maleMemberIds: string[];
  femaleMemberIds: string[];
};

const GENDERS = ["male", "female"] as const;

/**
 * 표준 시드를 넣고 id 모음을 돌려준다.
 * 순서는 FK 가 걸린 방향(학원 → 수업 → 신청 단위 → 회차·자리 묶음, 회원은 독립)을 따른다.
 */
export async function insertSeedFixtures(pool: Pool): Promise<SeedSummary> {
  // 1) 학원 1
  await pool.query(
    `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
     VALUES ($1, '시드 학원', '서울', '강남구', now(), ${ACADEMY_SELLER_VALUES}) ON CONFLICT (id) DO NOTHING`,
    [SEED_IDS.academy],
  );
  // 2) 정규 수업 1 — 남녀 정원을 따로 세는 수업(gender_split)
  await pool.query(
    `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
     VALUES ($1, $2, '시드 정규 수업', '시드 강사', 'salsa_bachata', 'regular', 'gender_split', now())
     ON CONFLICT (id) DO NOTHING`,
    [SEED_IDS.class, SEED_IDS.academy],
  );
  // 3) 신청 단위 1 — 정규 과정은 기간(term) 하나. 첫 회차 7일 뒤부터 매주 한 번, 마지막 회차 끝까지.
  await pool.query(
    `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount,
                                  first_session_starts_at, last_session_ends_at, status, updated_at)
     VALUES ($1, $2, '시드 8주 과정', 'term', 120000,
             date_trunc('day', now()) + interval '7 days 19 hours',
             date_trunc('day', now()) + interval '7 days 19 hours' + ($3 - 1) * interval '7 days' + interval '1 hour 30 minutes',
             'open', now())
     ON CONFLICT (id) DO NOTHING`,
    [SEED_IDS.offering, SEED_IDS.class, SEED_SESSION_COUNT],
  );
  // 4) 8회차 — seq 1~8, 한 회차 90분
  const sessionIds: string[] = [];
  for (let seq = 1; seq <= SEED_SESSION_COUNT; seq += 1) {
    const id = SEED_IDS.session(seq);
    sessionIds.push(id);
    await pool.query(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       VALUES ($1, $2, $3,
               date_trunc('day', now()) + interval '7 days 19 hours' + ($3 - 1) * interval '7 days',
               date_trunc('day', now()) + interval '7 days 19 hours' + ($3 - 1) * interval '7 days' + interval '1 hour 30 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [id, SEED_IDS.offering, seq],
    );
  }
  // 5) 자리 묶음 2개 — 남 6, 여 6 (아직 아무도 신청하지 않아 held·confirmed 는 0)
  for (const kind of GENDERS) {
    await pool.query(
      `INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at)
       VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.seatPool(kind), SEED_IDS.offering, kind, SEED_SEATS_PER_GENDER],
    );
  }
  // 6) 회원 12명 — 남 6 · 여 6. 본인확인 해시·로그인 id 는 회원마다 달라야 해서 id 를 섞어 만든다.
  const memberIds = { male: [] as string[], female: [] as string[] };
  for (const gender of GENDERS) {
    for (let n = 1; n <= SEED_SEATS_PER_GENDER; n += 1) {
      const id = SEED_IDS.member(gender, n);
      memberIds[gender].push(id);
      await pool.query(
        `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname,
                              signup_notice_ack_at, updated_at)
         VALUES ($1, $2, $3, $4, '1990-01-01', $5, $6, '시험 닉네임', now(), now()) ON CONFLICT (id) DO NOTHING`,
        [
          id,
          `seed-auth-${id}`,
          `시드 ${gender === "male" ? "남" : "여"}${n}`,
          gender,
          `010-0000-${gender === "male" ? "1" : "2"}${String(n).padStart(3, "0")}`,
          `seed-ci-${id}`,
        ],
      );
    }
  }
  return {
    academyId: SEED_IDS.academy,
    classId: SEED_IDS.class,
    offeringId: SEED_IDS.offering,
    sessionIds,
    seatPoolIds: { male: SEED_IDS.seatPool("male"), female: SEED_IDS.seatPool("female") },
    maleMemberIds: memberIds.male,
    femaleMemberIds: memberIds.female,
  };
}
