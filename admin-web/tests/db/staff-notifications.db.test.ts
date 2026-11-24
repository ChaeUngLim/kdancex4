// S1-4.6(직원 알림함 API) — `GET /api/staff/notifications` · `GET …/unread-count` · `POST …/{id}/read` · `POST …/read-all`
// (계약 10 §2)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-4-6.db.test.ts 였는데, 기능 이름(staff-notifications)으로 바꿨다.
//   verify:
//     · 수용 시나리오 3 — 안 읽은 approval 2·operations 1 → read-all {approval} → updated 2, unread total 1
//     · 수용 시나리오 4 — 강사 A 의 알림을 강사 B 가 읽음 처리 → 404, A 의 read_at 그대로
//     · 수용 시나리오 5 — 같은 소속 신청 알림 쓰기가 두 번 돌아도(dedupe_key) 알림함에는 1건
//     · 커서 넘김에서 중복·빠짐 0 (같은 시각 행이 여럿이어도)
//   나머지: 최신순 · 칩·학원 거르기 · 읽음 멱등(같은 본문) · 남의 알림은 목록·수에 없음 · 틀린 커서 422 ·
//           세션 없음 401 · 회원 403 · 2단계 전 401.
import { randomBytes, randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import {
  createListStaffNotificationsRoute,
  createReadAllStaffNotificationsRoute,
  createReadStaffNotificationRoute,
  createStaffUnreadCountRoute,
  readAllResponseSchema,
  staffNotificationListSchema,
  staffNotificationSchema,
  unreadCountResponseSchema,
} from "@/lib/server/services/staff-notifications";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { staffSessionCookie } from "../setup/staff-cookie";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 비밀값 글자가 저장소에 남지 않게 실행마다 새로 만든다(repo-secret-scan 규칙)
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("직원 알림함(계약 10 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let LIST: ReturnType<typeof createListStaffNotificationsRoute>;
  let COUNT: ReturnType<typeof createStaffUnreadCountRoute>;
  let READ: ReturnType<typeof createReadStaffNotificationRoute>;
  let READ_ALL: ReturnType<typeof createReadAllStaffNotificationsRoute>;
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyA = randomUUID();
  const academyB = randomUUID();
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  async function makeUser(key: string, twoFactor: boolean) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key.toLowerCase(), displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function makeStaff(key: string, opts: { twoFactor?: boolean } = {}) {
    const authUserId = await makeUser(key, opts.twoFactor ?? true);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      authUserId,
      key,
    ]);
    staffIds[key] = id;
  }

  /** 알림 한 줄을 바로 넣는다(쓰는 쪽 경로는 각자 테스트가 있다 — 여기서는 「알림함이 무엇을 보여 주나」만 본다) */
  async function insertNotification(input: {
    to: string;
    kind?: string;
    category: string | null;
    academyId?: string | null;
    createdAt?: string;
    readAt?: string | null;
    dedupeKey?: string | null;
    title?: string;
  }): Promise<string | null> {
    const result = await q(
      `INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload, created_at, read_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, now()), $8::timestamptz)
       ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        staffIds[input.to],
        input.academyId === undefined ? academyA : input.academyId,
        input.category,
        input.kind ?? "affiliation_requested",
        input.dedupeKey ?? null,
        JSON.stringify({ title: input.title ?? "알림", link: "/staff/instructors?status=pending" }),
        input.createdAt ?? null,
        input.readAt ?? null,
      ],
    );
    return (result.rows[0] as { id: string } | undefined)?.id ?? null;
  }

  // via: app = 강사·대표 앱(Bearer, 2단계 없음) · web = 관리자 웹(서명 쿠키, 2단계 필수). 기본은 앱
  let via: "app" | "web" = "app";
  const headersOf = (who: string | undefined): Record<string, string> => {
    if (who === undefined) return {};
    if (via === "web") return { cookie: staffSessionCookie(tokens[who]!, SECRET), "content-type": "application/json" };
    return { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" };
  };

  async function list(who: string | undefined, search = "") {
    const res = await LIST(new Request(`${BASE}/api/staff/notifications${search}`, { headers: headersOf(who) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: staffNotificationListSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] as string | undefined };
  }

  async function unread(who: string | undefined, search = "") {
    const res = await COUNT(new Request(`${BASE}/api/staff/notifications/unread-count${search}`, { headers: headersOf(who) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: unreadCountResponseSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] as string | undefined };
  }

  async function read(who: string | undefined, id: string) {
    const res = await READ(new Request(`${BASE}/api/staff/notifications/${id}/read`, { method: "POST", headers: headersOf(who) }), {
      params: Promise.resolve({ id }),
    });
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: staffNotificationSchema.parse(json), text, code: undefined };
    return { status: res.status, body: undefined, text, code: json["code"] as string | undefined };
  }

  async function readAll(who: string | undefined, body: unknown) {
    const res = await READ_ALL(
      new Request(`${BASE}/api/staff/notifications/read-all`, { method: "POST", headers: headersOf(who), body: JSON.stringify(body) }),
      undefined,
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: readAllResponseSchema.parse(json), code: undefined };
    return { status: res.status, body: undefined, code: json["code"] as string | undefined };
  }

  const readAtOf = async (id: string) =>
    ((await q("SELECT read_at FROM notifications WHERE id = $1", [id])).rows[0] as { read_at: Date | null }).read_at;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }), clock: systemClock };
    LIST = createListStaffNotificationsRoute(deps);
    COUNT = createStaffUnreadCountRoute(deps);
    READ = createReadStaffNotificationRoute(deps);
    READ_ALL = createReadAllStaffNotificationsRoute(deps);

    for (const [id, name] of [
      [academyA, "알림함 학원 A"],
      [academyB, "알림함 학원 B"],
    ] as const) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [id, name],
      );
    }
    await makeStaff("owner"); // 시나리오 3 의 대표
    await makeStaff("instructorA"); // 시나리오 4 의 강사 A
    await makeStaff("instructorB"); // 시나리오 4 의 강사 B
    await makeStaff("pager"); // 커서 넘김 전용
    await makeStaff("dedupe"); // 시나리오 5 의 대표
    await makeStaff("no2fa", { twoFactor: false });
    await makeUser("member", true); // 직원 계정이 없는 사람(회원 쪽 로그인)
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 수용 시나리오 3 ------------------------------------------------------------------------

  test("시나리오 3 — 안 읽은 approval 2·operations 1 → read-all {approval} → updated 2, unread total 1", async () => {
    await insertNotification({ to: "owner", category: "approval", title: "아이유 강사 소속 신청" });
    await insertNotification({ to: "owner", category: "approval", title: "이준호 강사 소속 신청" });
    await insertNotification({ to: "owner", kind: "terms_change_notice", category: "operations", title: "약관 변경" });
    // 이미 읽은 approval 1건 — 세지도, 다시 고치지도 않는다
    const alreadyRead = await insertNotification({ to: "owner", category: "approval", readAt: "2026-11-01T00:00:00Z" });

    const before = await unread("owner");
    expect(before.body).toEqual({ total: 3, byCategory: { approval: 2, operations: 1 } });

    const result = await readAll("owner", { category: "approval" });
    expect(result).toMatchObject({ status: 200, body: { updated: 2 } });

    const after = await unread("owner");
    expect(after.body).toEqual({ total: 1, byCategory: { operations: 1 } });
    // 이미 읽었던 알림은 처음 읽은 시각 그대로
    expect((await readAtOf(alreadyRead!))?.toISOString()).toBe("2026-11-01T00:00:00.000Z");

    // category 없이(null) 부르면 남은 칩 전체 — 이제 0
    expect(await readAll("owner", { category: null })).toMatchObject({ status: 200, body: { updated: 1 } });
    expect((await unread("owner")).body).toEqual({ total: 0, byCategory: {} });
    expect(await readAll("owner", {})).toMatchObject({ status: 200, body: { updated: 0 } });
  });

  // ---- 수용 시나리오 4 ------------------------------------------------------------------------

  test("시나리오 4 — 강사 A 의 알림을 강사 B 가 읽음 처리하면 404, A 의 read_at 그대로", async () => {
    const id = (await insertNotification({ to: "instructorA", kind: "affiliation_approved", category: "operations" }))!;

    const byB = await read("instructorB", id);
    expect(byB).toMatchObject({ status: 404, code: "NOT_FOUND" });
    // 404 본문에 남의 알림 내용이 섞이지 않는다
    expect(byB.text).not.toContain(id);
    expect(await readAtOf(id)).toBeNull();

    // 없는 id · 모양이 틀린 id 도 같은 404 — 「남의 것」과 「없는 것」을 구별할 수 없다
    expect(await read("instructorB", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await read("instructorB", "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });

    // B 의 목록·안 읽은 수에도 A 의 알림은 없다
    expect((await list("instructorB")).body!.items).toEqual([]);
    expect((await unread("instructorB")).body!.total).toBe(0);
    // B 가 「모두 읽음」을 눌러도 A 의 알림은 바뀌지 않는다
    expect(await readAll("instructorB", { category: null })).toMatchObject({ body: { updated: 0 } });
    expect(await readAtOf(id)).toBeNull();

    // A 본인은 읽음 처리할 수 있고, 두 번 불러도 같은 본문(처음 읽은 시각 그대로)
    const first = await read("instructorA", id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id, kind: "affiliation_approved", category: "operations", academyId: academyA });
    expect(first.body!.readAt).not.toBeNull();
    const second = await read("instructorA", id);
    expect(second.text).toBe(first.text);
  });

  // ---- 수용 시나리오 5 ------------------------------------------------------------------------

  test("시나리오 5 — 같은 소속 신청 알림 쓰기가 재시도로 두 번 돌아도 대표 알림함에는 1건(dedupe_key)", async () => {
    const key = `affiliation:${randomUUID()}:requested`;
    const first = await insertNotification({ to: "dedupe", category: "approval", dedupeKey: key });
    const retry = await insertNotification({ to: "dedupe", category: "approval", dedupeKey: key });
    expect(first).not.toBeNull();
    expect(retry).toBeNull();

    const res = await list("dedupe");
    expect(res.body!.items.map((i) => i.id)).toEqual([first]);
    expect((await unread("dedupe")).body).toEqual({ total: 1, byCategory: { approval: 1 } });
  });

  // ---- 커서 넘김 ------------------------------------------------------------------------------

  test("커서 넘김 — 최신순, 같은 시각 행이 여럿이어도 쪽을 넘기며 중복·빠짐 0", async () => {
    // 25건: 시각 5종 × 5건씩(같은 시각 묶음 안은 id 로 줄 선다). 학원·칩을 섞어 둔다
    const inserted: string[] = [];
    for (let t = 0; t < 5; t += 1) {
      for (let k = 0; k < 5; k += 1) {
        const id = await insertNotification({
          to: "pager",
          category: k % 2 === 0 ? "approval" : "operations",
          academyId: k === 4 ? academyB : academyA,
          createdAt: `2026-11-2${t}T01:00:00.123456Z`,
        });
        inserted.push(id!);
      }
    }

    // limit 7 로 끝까지 넘긴다
    const seen: string[] = [];
    const createdAts: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const search: string = `?limit=7${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await list("pager", search);
      expect(res.status).toBe(200);
      seen.push(...res.body!.items.map((i) => i.id));
      createdAts.push(...res.body!.items.map((i) => i.createdAt));
      cursor = res.body!.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(4); // 7 + 7 + 7 + 4
    // 중복 0 · 빠짐 0
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...inserted].sort());
    // 최신순(시각 내림차순, 같은 시각은 id 내림차순)
    const expectedOrder = (
      await q("SELECT id FROM notifications WHERE recipient_staff_account_id = $1 ORDER BY created_at DESC, id DESC", [staffIds["pager"]])
    ).rows.map((r) => (r as { id: string }).id);
    expect(seen).toEqual(expectedOrder);
    expect(createdAts[0]).toBe("2026-11-24T01:00:00.123456Z");

    // 마지막 쪽 = nextCursor null. 한 번에 다 받으면 다음 쪽 없음
    const all = await list("pager", "?limit=100");
    expect(all.body!.items).toHaveLength(25);
    expect(all.body!.nextCursor).toBeNull();

    // 칩·학원 거르기도 커서와 함께 겹침 없이
    const approvals: string[] = [];
    let c: string | null = "";
    while (c !== null) {
      const res = await list("pager", `?category=approval&academyId=${academyA}&limit=4${c === "" ? "" : `&cursor=${encodeURIComponent(c)}`}`);
      expect(res.body!.items.every((i) => i.category === "approval" && i.academyId === academyA)).toBe(true);
      approvals.push(...res.body!.items.map((i) => i.id));
      c = res.body!.nextCursor;
    }
    // k=0·2 는 학원 A 의 approval, k=4 는 학원 B → 시각 5종 × 2건
    expect(approvals).toHaveLength(10);
    expect(new Set(approvals).size).toBe(10);
    expect((await list("pager", `?academyId=${academyB}`)).body!.items).toHaveLength(5);
    expect((await unread("pager", `?academyId=${academyB}`)).body).toEqual({ total: 5, byCategory: { approval: 5 } });
  });

  // ---- 입력 검사·인증 -------------------------------------------------------------------------

  test("틀린 커서·없는 칩·너무 큰 limit·모르는 쿼리 이름은 422 VALIDATION_FAILED", async () => {
    for (const search of ["?cursor=garbage", "?category=marketing", "?limit=0", "?limit=101", "?academyId=nope", "?foo=1"]) {
      expect(await list("pager", search), search).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
    expect(await readAll("pager", { category: "marketing" })).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await unread("pager", "?academyId=nope")).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
  });

  test("세션 없음 401 · 회원(직원 계정 없음) 403 · 관리자 웹(쿠키)에서 2단계 전 세션 401 — 네 경로 모두", async () => {
    const id = randomUUID();
    via = "web";
    try {
      for (const [who, status, code] of [
        [undefined, 401, "UNAUTHENTICATED"],
        ["member", 403, "STAFF_ACCOUNT_REQUIRED"],
        ["no2fa", 401, "SECOND_FACTOR_REQUIRED"],
      ] as const) {
        expect(await list(who)).toMatchObject({ status, code });
        expect(await unread(who)).toMatchObject({ status, code });
        expect(await read(who, id)).toMatchObject({ status, code });
        expect(await readAll(who, {})).toMatchObject({ status, code });
      }
    } finally {
      via = "app";
    }
  });

  test("강사·대표 앱(Bearer)은 2단계를 묻지 않는다 — 같은 2단계 전 세션이 앱으로는 알림을 읽는다(계약 11 열린 점 ⑩)", async () => {
    expect((await list("no2fa")).status).toBe(200);
    expect((await unread("no2fa")).status).toBe(200);
  });
});
