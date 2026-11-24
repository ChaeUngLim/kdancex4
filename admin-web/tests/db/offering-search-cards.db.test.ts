// SX-5.3(조건 검색 결과를 수업 카드로) — MCP 읽기 도구 `search_offerings`(계약 16 §5-1 조건 · §5-2 offering_cards · §6).
//   verify ① 응답 수업 id 가 전부 같은 조건의 직접 검색 결과 안에 있다(지어낸 수업 0건, 플랜 SX-5 수용 ①)
//   verify ③ 승인 전 수업 · 입점 심사 전(게시 제한·노출 중지 포함) 학원의 수업은 0건이다
//   그리고: 카드 값(수업명·학원·홀·요일·시간·기간·레벨·남은 자리·가격·모집 상태)이 DB 값 그대로다 ·
//           개인 레슨은 「레슨 모집」(open) 시간만 보인다 · 조건이 하나도 없거나 이름만 있고 id 가 없으면 INVALID_INPUT
//
// 이름: verify 의 tests/db/sx-5-3.db.test.ts 는 Task 번호 이름이라 기능 이름(offering-search-cards)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 게시 수업·승인 대기 수업·개인 레슨 상품·모집 시간은 진짜 경로(S2-2 수업 등록 · S2-4 개인 레슨 개설·시간 열기)로 만든다.
// 손으로 넣는 것은 계정·학원·소속·홀 같은 바닥과, 아직 경로가 없는 상태(학원 게시 제한·노출 중지 · 자리 수 · 결제 중 시간)뿐이다.
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createReadToolServer } from "@/lib/server/ai/read-tools";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { offeringCardSchema, searchOfferingCards, type SearchOfferingsInput } from "@/lib/server/services/offering-search";
import { createPrivateLessonProductRoutes, privateLessonProductSchema } from "@/lib/server/services/private-lesson-products";
import { createPrivateLessonSlotRoutes, openSlotsResponseSchema } from "@/lib/server/services/private-lesson-slots";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 「지금」 = 2026-11-21 12:00 KST. 12월 수업·모집 시간이 모두 이 뒤다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

/** 비워 둔 조건(§5-1 모양 그대로 — 에이전트가 보내는 칸 11개 전부 null) */
const EMPTY = {
  instructor: null,
  academy: null,
  genre: null,
  weekdays: null,
  timeBand: null,
  level: null,
  regionSido: null,
  regionGu: null,
  maxPriceAmount: null,
  dateFrom: null,
  dateTo: null,
} as const;

type Schedule = { weekdays: string[]; startTime: string; endTime: string; periodFrom: string; periodTo: string };

describe.skipIf(!dbAvailable())("조건 검색 결과를 수업 카드로(계약 16 §5-2 · §6 search_offerings, SX-5.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  /** 수업 제목 → 판매 단위 id(개인 레슨은 상품 수업 id) */
  const itemIds: Record<string, string> = {};
  const deps = () => ({ db: handle.db, clock: fixedClock(NOW) });
  const routeDeps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });

  // ---- 바닥 -----------------------------------------------------------------------------------------

  async function makeStaff(key: string, displayName: string, role: "owner" | "instructor", genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, phone_masked, updated_at) VALUES ($1, $2, $3, 'active', '010-****-1234', now())", [
      id,
      user.id,
      displayName,
    ]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())", [id, genre]);
    }
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, name: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q("INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())", [
      branch,
      academyIds[key],
    ]);
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [roomIds[key], branch, `${key}홀`]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyIds[key], JSON.stringify(regularContent), staffIds["owner"]],
    );
  }

  /** active 소속 + 앱에서 수업을 올릴 위임(class_submit) */
  async function affiliate(academy: string, instructor: string) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  /**
   * S2-2 경로로 수업을 올린다. 대표가 올리면 바로 공개(published), 강사가 올리면 승인 대기(pending_approval).
   * 공개된 수업이면 판매 단위 id 를 itemIds[title] 에 적는다.
   */
  async function registerClass(
    who: "owner" | string,
    academy: string,
    instructor: string,
    body: { title: string; genre: string; subGenre: string; discipline: string | null; targetLevel: string; priceAmount: number; schedule: Schedule },
  ) {
    const reg = createClassRegistrationRoutes(routeDeps());
    const headers = { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId: academyIds[academy],
          classKind: "regular",
          title: body.title,
          genre: body.genre,
          subGenre: body.subGenre,
          discipline: body.discipline,
          targetLevel: body.targetLevel,
          targetAges: ["all"],
          roomId: roomIds[academy],
          priceAmount: body.priceAmount,
          schedule: { kind: "recurring", ...body.schedule },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: staffIds[instructor],
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers, body: "{}" }), {
      params: Promise.resolve({ classId }),
    });
    expect(submitted.status).toBe(200);
    const { rows } = await q("SELECT o.id FROM class_offerings o WHERE o.class_id = $1", [classId]);
    itemIds[body.title] = (rows[0] as { id: string } | undefined)?.id ?? `none-${classId}`;
    return classId;
  }

  /** 판매 단위의 한 자리 묶음 수를 바꾼다(주문·결제 경로 대신 — 모집 상태 계산만 보려는 것) */
  async function setPool(title: string, seatKind: "male" | "female", held: number, confirmed: number) {
    await q("UPDATE seat_pools SET held_count = $3, confirmed_count = $4 WHERE offering_id = $1 AND seat_kind = $2", [itemIds[title], seatKind, held, confirmed]);
  }

  const search = (input: Partial<SearchOfferingsInput>) => searchOfferingCards(deps(), { ...EMPTY, limit: 20, ...input });
  const ids = (cards: { offeringId: string | null; classId: string }[]) => cards.map((c) => c.offeringId ?? c.classId).sort();
  const expectedIds = (...titles: string[]) => titles.map((t) => itemIds[t] ?? `missing-${t}`).sort();
  const junho = () => ({ name: "이준호", id: staffIds["junho"] ?? null });

  // ---- 직접 검색(시험용 기준) — 도구와 따로 쓴 SQL 로 「같은 조건에 맞는 공개 수업」을 센다 ----------------------
  // 도구가 낸 id 가 이 집합 밖에 하나라도 있으면 도구가 수업을 지어냈거나 공개 조건을 놓친 것이다(수용 ①).
  // 요일·시간대는 회차를 KST 로 바꿔 JS 로 본다(도구는 SQL·함수로 보므로 계산 길이 다르다).
  async function directSearch(input: Partial<SearchOfferingsInput>): Promise<string[]> {
    const c = { ...EMPTY, ...input };
    const band =
      c.timeBand === null || c.timeBand === undefined
        ? null
        : typeof c.timeBand === "string"
          ? ({ morning: ["06:00", "12:00"], afternoon: ["12:00", "18:00"], evening: ["18:00", "24:00"] } as const)[c.timeBand]
          : [c.timeBand.from, c.timeBand.to];
    const dows = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const fits = (dow: number, start: string, end: string) =>
      (c.weekdays === null || c.weekdays === undefined || c.weekdays.includes(dows[dow] as never)) &&
      (band === null || (start >= band[0] && end <= band[1]));

    const regular = await q(
      `SELECT o.id, extract(isodow FROM s.starts_at AT TIME ZONE 'Asia/Seoul')::int AS dow,
              to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS st,
              CASE WHEN (s.ends_at AT TIME ZONE 'Asia/Seoul')::date > (s.starts_at AT TIME ZONE 'Asia/Seoul')::date THEN '24:00'
                   ELSE to_char(s.ends_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') END AS en
       FROM class_offerings o JOIN classes cl ON cl.id = o.class_id JOIN academies a ON a.id = cl.academy_id
       JOIN class_sessions s ON s.offering_id = o.id AND s.status = 'scheduled'
       WHERE cl.status = 'published' AND o.status = 'open' AND a.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM academy_restrictions r WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
         AND o.first_session_starts_at > $1::timestamptz
         AND ($2::uuid IS NULL OR cl.instructor_account_id = $2::uuid) AND ($3::uuid IS NULL OR a.id = $3::uuid)
         AND ($4::text IS NULL OR cl.genre::text = $4) AND ($5::text IS NULL OR cl.target_level::text = $5)`,
      [NOW.toString(), c.instructor?.id ?? null, c.academy?.id ?? null, c.genre ?? null, c.level ?? null],
    );
    const byOffering = new Map<string, boolean>();
    for (const row of regular.rows as { id: string; dow: number; st: string; en: string }[]) {
      byOffering.set(row.id, (byOffering.get(row.id) ?? true) && fits(row.dow, row.st, row.en));
    }
    const privateLessons = await q(
      `SELECT cl.id, extract(isodow FROM s.starts_at AT TIME ZONE 'Asia/Seoul')::int AS dow,
              to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS st, to_char(s.ends_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS en
       FROM classes cl JOIN private_lesson_products p ON p.class_id = cl.id JOIN academies a ON a.id = cl.academy_id
       JOIN private_lesson_slots s ON s.product_class_id = cl.id AND s.status = 'open' AND s.starts_at > $1::timestamptz
       WHERE cl.status = 'published' AND p.status = 'open' AND a.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM academy_restrictions r WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)
         AND ($2::uuid IS NULL OR cl.instructor_account_id = $2::uuid) AND ($3::uuid IS NULL OR a.id = $3::uuid)
         AND ($4::text IS NULL OR cl.genre::text = $4) AND $5::text IS NULL`,
      [NOW.toString(), c.instructor?.id ?? null, c.academy?.id ?? null, c.genre ?? null, c.level ?? null],
    );
    const plFits = new Set<string>();
    for (const row of privateLessons.rows as { id: string; dow: number; st: string; en: string }[]) {
      if (fits(row.dow, row.st, row.en)) plFits.add(row.id);
    }
    return [...[...byOffering].filter(([, ok]) => ok).map(([id]) => id), ...plFits].sort();
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "대표 박", "owner");
    await makeStaff("junho", "이준호", "instructor", "dance_sport");
    await makeStaff("mina", "정민아", "instructor", "salsa_bachata");
    await makeAcademy("A", "라틴하우스 강남");
    await makeAcademy("B", "스텝업 마포");
    await makeAcademy("R", "탱고원 합정"); // 수업을 올린 뒤 게시 제한(restricted)으로 바뀐다
    await makeAcademy("S", "스윙타임"); // 수업을 올린 뒤 노출 중지(listing_suspended)가 열린다
    for (const academy of ["A", "B", "R", "S"]) await affiliate(academy, "junho");
    await affiliate("A", "mina");

    const dec = (weekdays: string[], startTime: string, endTime: string, periodFrom = "2026-12-01", periodTo = "2026-12-31") => ({
      weekdays,
      startTime,
      endTime,
      periodFrom,
      periodTo,
    });
    // 대표가 올려 바로 공개된 수업 4개(이준호 3 · 정민아 1)
    await registerClass("owner", "A", "junho", {
      title: "쌈바 입문반",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "samba",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: dec(["tue", "thu"], "19:00", "20:00", "2026-12-01", "2026-12-24"),
    });
    await registerClass("owner", "A", "junho", {
      title: "룸바 주말반",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "rumba",
      targetLevel: "beginner",
      priceAmount: 140000,
      schedule: dec(["sat", "sun"], "10:00", "11:00", "2026-12-05", "2026-12-27"),
    });
    await registerClass("owner", "B", "junho", {
      title: "차차차 토요 오전",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "cha_cha_cha",
      targetLevel: "beginner",
      priceAmount: 100000,
      schedule: dec(["sat"], "08:00", "09:30", "2026-12-05", "2026-12-26"),
    });
    await registerClass("owner", "A", "mina", {
      title: "바차타 커플반",
      genre: "salsa_bachata",
      subGenre: "bachata",
      discipline: null,
      targetLevel: "entry",
      priceAmount: 140000,
      schedule: dec(["thu"], "21:00", "22:00"),
    });
    // 보이면 안 되는 것 셋: 게시 제한된 학원 · 노출 중지된 학원 · 강사가 올려 승인 대기
    await registerClass("owner", "R", "junho", {
      title: "자이브 저녁반",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "jive",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: dec(["wed"], "19:00", "20:00"),
    });
    await registerClass("owner", "S", "junho", {
      title: "파소도블레 월요반",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "paso_doble",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: dec(["mon"], "19:00", "20:00"),
    });
    const pendingClassId = await registerClass("junho", "A", "junho", {
      title: "자이브 금요반",
      genre: "dance_sport",
      subGenre: "latin",
      discipline: "jive",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: dec(["fri"], "19:00", "20:00"),
    });
    const pending = await q("SELECT status::text AS status FROM classes WHERE id = $1", [pendingClassId]);
    expect((pending.rows[0] as { status: string }).status).toBe("pending_approval");
    await q("UPDATE academies SET status = 'restricted' WHERE id = $1", [academyIds["R"]]);
    await q("INSERT INTO academy_restrictions (id, academy_id, kind, reason, started_at) VALUES (uuidv7(), $1, 'listing_suspended', '폐업 확인 뒤 노출 중지', now())", [
      academyIds["S"],
    ]);

    // 자리: 쌈바 입문반 남자 자리 1개 남음(마감 임박) · 차차차 토요 오전 남녀 모두 마감
    await setPool("쌈바 입문반", "male", 1, 4);
    await setPool("차차차 토요 오전", "male", 0, 6);
    await setPool("차차차 토요 오전", "female", 2, 4);

    // 이준호의 개인 레슨(라틴하우스 강남) — S2-4 경로로 상품을 열고 「레슨 모집」 시간 3칸을 연다
    const product = await createPrivateLessonProductRoutes(routeDeps()).create(
      new Request(`${BASE}/api/instructor/private-lesson-products`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens["junho"]}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ academyId: academyIds["A"], subGenre: "latin", lessonMinutes: 50, sessionCount: 10, priceAmount: 600000 }),
      }),
      undefined,
    );
    expect(product.status).toBe(201);
    const { classId: productId } = privateLessonProductSchema.parse(await product.json());
    itemIds["개인 레슨"] = productId;
    const opened = await createPrivateLessonSlotRoutes(routeDeps()).open(
      new Request(`${BASE}/api/instructor/private-lesson-products/${productId}/slots`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens["junho"]}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          slots: [
            { startsAt: "2026-12-05T04:00:00Z", endsAt: "2026-12-05T04:50:00Z" }, // 토 13:00–13:50 KST
            { startsAt: "2026-12-06T05:00:00Z", endsAt: "2026-12-06T05:50:00Z" }, // 일 14:00–14:50 KST
            { startsAt: "2026-12-12T06:00:00Z", endsAt: "2026-12-12T06:50:00Z" }, // 토 15:00–15:50 KST → 결제 중(held)으로 바꾼다
          ],
          roomId: roomIds["A"],
          repeatWeeks: 1,
        }),
      }),
      { params: Promise.resolve({ classId: productId }) },
    );
    expect(opened.status).toBe(201);
    const created = openSlotsResponseSchema.parse(await opened.json()).created;
    expect(created).toHaveLength(3);
    // 회원 결제가 그 시간을 잡은 상태(구매 경로가 아직 없어 상태만 바꾼다) — 회원에게는 이제 「레슨 모집」 시간이 아니다
    await q("UPDATE private_lesson_slots SET status = 'held', held_until = now() + interval '10 minutes' WHERE id = $1", [created[2]?.slotId]);
  });

  afterAll(async () => {
    await closeTestDb(handle);
  });

  // ---- verify ①: 지어낸 수업 0건 -------------------------------------------------------------------

  const CASES: [string, () => Partial<SearchOfferingsInput>, string[]][] = [
    ["강사만(이준호 전체 학원)", () => ({ instructor: junho() }), ["쌈바 입문반", "룸바 주말반", "차차차 토요 오전", "개인 레슨"]],
    ["강사 + 학원", () => ({ instructor: junho(), academy: { name: "라틴하우스 강남", id: academyIds["A"] ?? null } }), ["쌈바 입문반", "룸바 주말반", "개인 레슨"]],
    ["강사 + 주말 오전", () => ({ instructor: junho(), weekdays: ["sat", "sun"], timeBand: "morning" }), ["룸바 주말반", "차차차 토요 오전"]],
    ["강사 + 주말 오후(개인 레슨 모집 시간만 걸림)", () => ({ instructor: junho(), weekdays: ["sat", "sun"], timeBand: "afternoon" }), ["개인 레슨"]],
    ["장르만", () => ({ genre: "salsa_bachata" }), ["바차타 커플반"]],
    ["강사 + 레벨", () => ({ instructor: junho(), level: "beginner" }), ["룸바 주말반", "차차차 토요 오전"]],
    ["시각 구간 18:00–21:00", () => ({ timeBand: { from: "18:00", to: "21:00" } }), ["쌈바 입문반"]],
  ];

  test.each(CASES)("응답 수업 id 가 전부 같은 조건의 직접 검색 결과 안에 있다 — %s", async (_label, input, titles) => {
    const cards = await search(input());
    const direct = await directSearch(input());
    for (const id of ids(cards)) expect(direct).toContain(id);
    expect(ids(cards)).toEqual(direct);
    expect(ids(cards)).toEqual(expectedIds(...titles));
  });

  // ---- verify ③: 승인 전·입점 심사 전 학원 수업 0건 ---------------------------------------------------

  test("승인 대기 수업 · 게시 제한 학원 · 노출 중지 학원의 수업은 어떤 조건으로도 나오지 않는다", async () => {
    const hidden = new Set(expectedIds("자이브 저녁반", "파소도블레 월요반"));
    const everything = [
      ...(await search({ instructor: junho() })),
      ...(await search({ genre: "dance_sport" })),
      ...(await search({ level: "entry" })),
      ...(await search({ weekdays: ["mon", "wed", "fri"] })),
      ...(await search({ academy: { name: "탱고원 합정", id: academyIds["R"] ?? null } })),
      ...(await search({ academy: { name: "스윙타임", id: academyIds["S"] ?? null } })),
    ];
    expect(everything.filter((c) => hidden.has(c.offeringId ?? ""))).toEqual([]);
    expect(everything.filter((c) => c.title === "자이브 금요반" || c.title === "자이브 저녁반" || c.title === "파소도블레 월요반")).toEqual([]);
    expect(await search({ weekdays: ["mon", "wed", "fri"] })).toEqual([]);
  });

  // ---- 카드 값 -------------------------------------------------------------------------------------

  test("카드에 수업명·학원·홀·요일·시간·기간·레벨·남은 자리·가격·모집 상태가 DB 값 그대로 실린다", async () => {
    const cards = await search({ instructor: junho(), academy: { name: "라틴하우스 강남", id: academyIds["A"] ?? null } });
    const samba = offeringCardSchema.parse(cards.find((c) => c.title === "쌈바 입문반"));
    expect(samba).toEqual({
      offeringId: itemIds["쌈바 입문반"],
      classId: samba.classId,
      title: "쌈바 입문반",
      genre: "dance_sport",
      isPrivateLesson: false,
      academy: { id: academyIds["A"], name: "라틴하우스 강남" },
      hall: "A홀",
      pattern: [
        { weekday: "tue", startTime: "19:00", endTime: "20:00" },
        { weekday: "thu", startTime: "19:00", endTime: "20:00" },
      ],
      firstSessionDate: "2026-12-01",
      lastSessionDate: "2026-12-24",
      sessionCount: 8,
      level: "entry",
      pools: [
        { seatKind: "male", remaining: 1 },
        { seatKind: "female", remaining: 6 },
      ],
      priceAmount: 120000,
      recruitStatus: "closing_soon",
      waitlistAvailable: false,
      action: { type: "open_offering", offeringId: itemIds["쌈바 입문반"], classId: samba.classId },
    });
    const rumba = offeringCardSchema.parse(cards.find((c) => c.title === "룸바 주말반"));
    expect(rumba.recruitStatus).toBe("open");
    expect(rumba.pattern.map((p) => p.weekday)).toEqual(["sat", "sun"]);
    expect(rumba.sessionCount).toBe(8);

    const chacha = offeringCardSchema.parse((await search({ instructor: junho(), level: "beginner" })).find((c) => c.title === "차차차 토요 오전"));
    expect(chacha.recruitStatus).toBe("full");
    expect(chacha.pools).toEqual([
      { seatKind: "male", remaining: 0 },
      { seatKind: "female", remaining: 0 },
    ]);
    expect(chacha.academy.name).toBe("스텝업 마포");
  });

  test("개인 레슨은 「레슨 모집」(open) 시간만 보인다 — 결제 중(held) 시간은 요일·시간·기간 어디에도 없다", async () => {
    const cards = await search({ instructor: junho(), academy: { name: "라틴하우스 강남", id: academyIds["A"] ?? null } });
    const lesson = offeringCardSchema.parse(cards.find((c) => c.isPrivateLesson));
    expect(lesson).toMatchObject({
      offeringId: null,
      classId: itemIds["개인 레슨"],
      isPrivateLesson: true,
      hall: "A홀",
      pattern: [
        { weekday: "sat", startTime: "13:00", endTime: "13:50" },
        { weekday: "sun", startTime: "14:00", endTime: "14:50" },
      ],
      firstSessionDate: "2026-12-05",
      lastSessionDate: "2026-12-06",
      sessionCount: 10,
      level: null,
      pools: [],
      priceAmount: 600000,
      recruitStatus: "open",
      action: { type: "open_offering", offeringId: null, classId: itemIds["개인 레슨"] },
    });
  });

  test("limit 은 카드 수만 자르고, 앞선 순서(첫 회차가 가까운 순)를 지킨다", async () => {
    const all = await search({ instructor: junho() });
    const two = await search({ instructor: junho(), limit: 2 });
    expect(two.map((c) => c.title)).toEqual(all.slice(0, 2).map((c) => c.title));
    expect(all.map((c) => c.firstSessionDate)).toEqual([...all.map((c) => c.firstSessionDate)].sort());
  });

  // ---- MCP 로 부르기 --------------------------------------------------------------------------------

  async function connectedClient() {
    const server = createReadToolServer(deps());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "offering-search-test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }
  const textOf = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content)[0]?.text ?? "{}") as unknown;

  test("MCP search_offerings — 읽기 전용 표시, { data: 카드, sources } 응답, 카드 id 가 직접 검색 안에 있다", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "search_offerings");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);

    const input: Partial<SearchOfferingsInput> = { instructor: junho(), weekdays: ["sat", "sun"], timeBand: "morning" };
    const result = await client.callTool({ name: "search_offerings", arguments: { ...EMPTY, ...input, limit: 10 } });
    expect(result.isError).not.toBe(true);
    const payload = textOf(result) as { data: unknown[]; sources: { kind: string; id: string; label: string }[] };
    const cards = payload.data.map((c) => offeringCardSchema.parse(c));
    expect(ids(cards)).toEqual(await directSearch(input));
    expect(payload.sources.map((s) => s.id).sort()).toEqual(ids(cards));
    expect(payload.sources.every((s) => s.kind === "offering")).toBe(true);
    await client.close();
  });

  test("조건이 하나도 없거나 · 이름만 있고 id 가 없거나 · 모르는 칸(memberId)이면 INVALID_INPUT 이고 데이터는 한 글자도 없다", async () => {
    const client = await connectedClient();
    const bad = [
      { ...EMPTY, limit: 5 },
      { ...EMPTY, instructor: { name: "이준호", id: null }, limit: 5 },
      { ...EMPTY, academy: { name: "라틴하우스 강남", id: null }, limit: 5 },
      { ...EMPTY, instructor: junho(), limit: 5, memberId: randomUUID() },
      { ...EMPTY, instructor: junho(), limit: 21 },
      { ...EMPTY, timeBand: { from: "21:00", to: "18:00" }, limit: 5 },
    ];
    for (const args of bad) {
      const result = await client.callTool({ name: "search_offerings", arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toEqual({ code: "INVALID_INPUT" });
    }
    await client.close();
  });

  test("이 도구는 읽기만 한다 — 부른 뒤에도 자리 수·모집 시간 상태가 그대로다", async () => {
    const before = await q("SELECT string_agg(seat_kind::text || held_count || confirmed_count, ',' ORDER BY id) AS s FROM seat_pools");
    const slotsBefore = await q("SELECT string_agg(status::text, ',' ORDER BY id) AS s FROM private_lesson_slots");
    await search({ instructor: junho() });
    expect((await q("SELECT string_agg(seat_kind::text || held_count || confirmed_count, ',' ORDER BY id) AS s FROM seat_pools")).rows).toEqual(before.rows);
    expect((await q("SELECT string_agg(status::text, ',' ORDER BY id) AS s FROM private_lesson_slots")).rows).toEqual(slotsBefore.rows);
  });
});
