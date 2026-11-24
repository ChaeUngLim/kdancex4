// SX-5.1(강사·학원 이름 후보 찾기) — MCP 읽기 도구 `find_instructors` · `find_academies`(계약 16 §6 · §5-2 instructor_candidates).
//   verify ② 같은 이름 강사 2명이면 후보 2건·확정 0건, 1명이면 확정 1건(플랜 SX-5 수용 「같은 이름 강사 2명이면 후보 카드가 먼저」)
//   verify   읽기 도구 목록에 더해도 쓰기 도구 0개(FR-214(AI 쓰기 금지)) — 진짜 MCP 서버에 올려 tools/list 로 센다
//   그리고: 정확히 같은 이름만(앞뒤 공백만 무시) · 학원 이름으로 좁히기 · 공개되지 않은 강사·학원은 후보가 아님 ·
//           후보 카드는 사진·활동 장르·소속 학원·게시 수업 수만(연락처·본명 칸 없음) · limit 은 후보 수만 자르고 판정은 그대로
//
// 이름: verify 의 tests/db/sx-5-1.db.test.ts 는 Task 번호 이름이라 기능 이름(name-candidates)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 게시 수업은 시드가 아니라 S2-2 의 진짜 수업 등록 경로(대표가 올려 바로 공개)로 만든다. 손으로 넣는 것은 계정·학원·소속 같은 바닥뿐이다.
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { CONTRACT_READ_TOOL_NAMES, createReadToolServer } from "@/lib/server/ai/read-tools";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import {
  academyCandidatesResultSchema,
  findAcademyCandidates,
  findInstructorCandidates,
  findPublicInstructorById,
  instructorCandidatesResultSchema,
} from "@/lib/server/services/name-candidates";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 12월 수업(12/01~12/24)이 모두 이 시각 뒤다 — 게시 수업 수에 들어간다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

// 쓰기 동사 — 도구 이름에 이것이 들어가면 쓰기 도구로 본다(SX-1.2 의 Python 테스트와 같은 목록)
const WRITE_VERBS = ["create", "update", "delete", "cancel", "refund", "pay", "book", "reserve", "publish", "approve", "submit", "write", "set_", "send"];

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

describe.skipIf(!dbAvailable())("강사·학원 이름 후보 찾기(계약 16 §6, SX-5.1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const deps = () => ({ db: handle.db, clock: fixedClock(NOW) });

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

  async function makeAcademy(key: string, name: string, status = "active") {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', $3, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name, status],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q("INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())", [
      branch,
      academyIds[key],
    ]);
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyIds[key], JSON.stringify(regularContent), staffIds["owner"]],
    );
  }

  async function affiliate(academy: string, instructor: string, status = "active") {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now(), CASE WHEN $3 = 'pending' THEN NULL ELSE now() END, now())`,
      [academyIds[academy], staffIds[instructor], status],
    );
  }

  /** 대표가 담당 강사를 골라 올린 정규 과정(바로 공개) — S2-2 경로 */
  async function publishClassAsOwner(academy: string, instructor: string, title: string) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId: academyIds[academy],
          classKind: "regular",
          title,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: roomIds[academy],
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "19:00", endTime: "20:00", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
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
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "대표 박", "owner");
    // 같은 이름 「김하나」 둘(서로 다른 학원) + 소속 승인 대기인 셋째(공개 소속이 없어 후보가 아니다)
    await makeStaff("hana1", "김하나", "instructor", "dance_sport");
    await makeStaff("hana2", "김하나", "instructor", "salsa_bachata");
    await makeStaff("hana3", "김하나", "instructor", "dance_sport");
    // 이름이 하나뿐인 「이준호」 — 사진 있음 · 게시 수업 1개 · 두 학원 소속
    await makeStaff("junho", "이준호", "instructor", "dance_sport");
    // 후보에서 빠져야 하는 같은 이름들: 역할 취소 · 계정 정지 · 게시 제한 학원에만 소속
    await makeStaff("revoked", "최민수", "instructor", "dance_sport");
    await makeStaff("suspended", "최민수", "instructor", "dance_sport");
    await makeStaff("restricted", "최민수", "instructor", "dance_sport");

    await makeAcademy("A", "라틴하우스 강남");
    await makeAcademy("B", "스텝업 마포");
    await makeAcademy("R", "라틴하우스 강남", "restricted"); // 이름은 같지만 게시 제한 — 학원 후보가 아니다
    await makeAcademy("S", "스윙타임"); // 노출 중지(listing_suspended) 를 연다
    await makeAcademy("D1", "댄스온");
    await makeAcademy("D2", "댄스온"); // 같은 이름 학원 둘 → ambiguous
    await q("INSERT INTO academy_restrictions (id, academy_id, kind, reason, started_at) VALUES (uuidv7(), $1, 'listing_suspended', '폐업 확인 뒤 노출 중지', now())", [
      academyIds["S"],
    ]);

    await affiliate("A", "hana1");
    await affiliate("B", "hana2");
    await affiliate("A", "hana3", "pending");
    await affiliate("A", "junho");
    await affiliate("B", "junho");
    await affiliate("S", "junho"); // 노출 중지 학원은 카드의 소속 학원에 안 나온다
    await affiliate("A", "revoked");
    await affiliate("A", "suspended");
    await affiliate("R", "restricted");
    await q("UPDATE role_grants SET status = 'revoked', revoked_at = now() WHERE staff_account_id = $1", [staffIds["revoked"]]);
    await q("UPDATE staff_accounts SET status = 'suspended' WHERE id = $1", [staffIds["suspended"]]);

    const photoId = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name, attached_at)
       VALUES ($1, $2, 'instructor_photo', 'public', $3, 'image/png', 10, 'x', '프로필.png', now())`,
      [photoId, staffIds["junho"], `k-${photoId}.png`],
    );
    await q("UPDATE instructor_profiles SET photo_file_id = $1 WHERE staff_account_id = $2", [photoId, staffIds["junho"]]);

    await publishClassAsOwner("A", "junho", "삼바 입문반");
  });

  afterAll(async () => {
    await closeTestDb(handle);
  });

  // ---- 강사 후보 ------------------------------------------------------------------------------------

  test("같은 이름 강사 2명이면 후보 2건이고 확정은 0건이다(ambiguous)", async () => {
    const result = instructorCandidatesResultSchema.parse(await findInstructorCandidates(deps(), { name: "김하나", limit: 5 }));
    expect(result.resolution).toBe("ambiguous");
    expect(result.resolved).toBeNull();
    expect(result.candidates.map((c) => c.instructorId).sort()).toEqual([staffIds["hana1"], staffIds["hana2"]].sort());
    // 소속 승인 대기(pending)인 셋째 「김하나」는 공개 소속이 없어 후보가 아니다
    expect(result.candidates.map((c) => c.instructorId)).not.toContain(staffIds["hana3"]);
    // 후보마다 사진·활동 장르·소속 학원이 달라 회원이 고를 수 있다
    const byId = Object.fromEntries(result.candidates.map((c) => [c.instructorId, c]));
    expect(byId[staffIds["hana1"] ?? ""]?.genres).toEqual(["dance_sport"]);
    expect(byId[staffIds["hana2"] ?? ""]?.genres).toEqual(["salsa_bachata"]);
    expect(byId[staffIds["hana1"] ?? ""]?.academies).toEqual([{ id: academyIds["A"], name: "라틴하우스 강남" }]);
    expect(byId[staffIds["hana2"] ?? ""]?.academies).toEqual([{ id: academyIds["B"], name: "스텝업 마포" }]);
  });

  test("이름이 하나뿐이면 확정 1건이고 카드 값(사진·장르·소속 학원·게시 수업 수)이 채워진다(unique)", async () => {
    const result = instructorCandidatesResultSchema.parse(await findInstructorCandidates(deps(), { name: "이준호", limit: 5 }));
    expect(result.resolution).toBe("unique");
    expect(result.candidates).toHaveLength(1);
    const junho = result.candidates[0];
    expect(result.resolved).toEqual(junho);
    expect(junho?.instructorId).toBe(staffIds["junho"]);
    expect(junho?.displayName).toBe("이준호");
    expect(junho?.photoUrl).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
    expect(junho?.genres).toEqual(["dance_sport"]);
    // 노출 중지 학원(S)은 소속이어도 카드에 안 나온다 — 이름 순
    expect(junho?.academies.map((a) => a.name)).toEqual(["라틴하우스 강남", "스텝업 마포"]);
    expect(junho?.publishedOfferingCount).toBe(1);
    expect(junho?.action).toEqual({ type: "select_instructor", instructorId: staffIds["junho"] });
  });

  test("후보 카드에는 사진·장르·소속 학원만 있고 연락처·본명 같은 칸이 없다", async () => {
    const raw = await findInstructorCandidates(deps(), { name: "이준호", limit: 5 });
    const keys = Object.keys(raw.candidates[0] ?? {}).sort();
    expect(keys).toEqual(["academies", "action", "displayName", "genres", "instructorId", "photoUrl", "publishedOfferingCount"]);
    expect(JSON.stringify(raw)).not.toContain("010-");
  });

  test("정확히 같은 이름만 다룬다 — 앞뒤 공백은 무시하고 일부·비슷한 이름은 없음(none)", async () => {
    expect((await findInstructorCandidates(deps(), { name: "  이준호 ", limit: 5 })).resolution).toBe("unique");
    for (const name of ["이준", "이 준호", "준호", "이준호강사"]) {
      const result = await findInstructorCandidates(deps(), { name, limit: 5 });
      expect(result).toEqual({ resolution: "none", resolved: null, candidates: [] });
    }
  });

  test("역할 취소·계정 정지·게시 제한 학원에만 소속된 강사는 후보가 아니다", async () => {
    const result = await findInstructorCandidates(deps(), { name: "최민수", limit: 5 });
    expect(result).toEqual({ resolution: "none", resolved: null, candidates: [] });
  });

  test("강사 id 로 읽기(SX-5.7 강사 프로필·정해진 강사) — 이름 찾기와 같은 카드, 숨은 강사·틀린 id 는 null", async () => {
    const byName = await findInstructorCandidates(deps(), { name: "이준호", limit: 5 });
    expect(await findPublicInstructorById(deps(), staffIds["junho"] ?? "")).toEqual(byName.resolved);
    // 동명이인도 id 로는 하나로 정해진다
    expect((await findPublicInstructorById(deps(), staffIds["hana2"] ?? ""))?.academies).toEqual([{ id: academyIds["B"], name: "스텝업 마포" }]);
    // 소속 대기·역할 취소·계정 정지·게시 제한 학원에만 소속 — 이름으로 안 나오면 id 로도 안 나온다
    for (const key of ["hana3", "revoked", "suspended", "restricted"]) {
      expect(await findPublicInstructorById(deps(), staffIds[key] ?? "")).toBeNull();
    }
    expect(await findPublicInstructorById(deps(), "not-a-uuid")).toBeNull();
    expect(await findPublicInstructorById(deps(), randomUUID())).toBeNull();
  });

  test("학원 이름을 같이 주면 그 학원 소속으로 좁혀 같은 이름이라도 확정된다", async () => {
    const result = await findInstructorCandidates(deps(), { name: "김하나", academyName: "스텝업 마포", limit: 5 });
    expect(result.resolution).toBe("unique");
    expect(result.resolved?.instructorId).toBe(staffIds["hana2"]);
    const none = await findInstructorCandidates(deps(), { name: "김하나", academyName: "없는 학원", limit: 5 });
    expect(none.resolution).toBe("none");
  });

  test("limit 은 돌려줄 후보 수만 자르고 판정은 전체 수로 한다(1건만 받아도 ambiguous)", async () => {
    const result = await findInstructorCandidates(deps(), { name: "김하나", limit: 1 });
    expect(result.resolution).toBe("ambiguous");
    expect(result.resolved).toBeNull();
    expect(result.candidates).toHaveLength(1);
  });

  // ---- 학원 후보 ------------------------------------------------------------------------------------

  test("학원: 같은 이름이 공개 학원 하나뿐이면 확정, 둘이면 후보만, 노출 중지 학원은 없음", async () => {
    // 「라틴하우스 강남」은 둘이지만 하나는 게시 제한(restricted)이라 공개 학원은 하나다
    const latin = academyCandidatesResultSchema.parse(await findAcademyCandidates(deps(), { name: "라틴하우스 강남", limit: 5 }));
    expect(latin.resolution).toBe("unique");
    expect(latin.resolved).toEqual({
      academyId: academyIds["A"],
      name: "라틴하우스 강남",
      regionSido: "서울",
      regionGu: "강남구",
      publishedOfferingCount: 1,
    });

    const danceOn = academyCandidatesResultSchema.parse(await findAcademyCandidates(deps(), { name: "댄스온", limit: 5 }));
    expect(danceOn.resolution).toBe("ambiguous");
    expect(danceOn.resolved).toBeNull();
    expect(danceOn.candidates.map((c) => c.academyId).sort()).toEqual([academyIds["D1"], academyIds["D2"]].sort());

    expect((await findAcademyCandidates(deps(), { name: "스윙타임", limit: 5 })).resolution).toBe("none");
    expect((await findAcademyCandidates(deps(), { name: "라틴하우스", limit: 5 })).resolution).toBe("none");
  });

  // ---- MCP 도구 목록 --------------------------------------------------------------------------------

  async function connectedClient() {
    const server = createReadToolServer(deps());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "sx-5-1-test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  test("읽기 도구 목록에 더해도 쓰기 도구는 0개다 — tools/list 이름이 전부 계약 §6 읽기 도구이고 readOnlyHint", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["find_instructors", "find_academies"]));
    for (const tool of tools) {
      expect(CONTRACT_READ_TOOL_NAMES).toContain(tool.name);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    const writeTools = names.filter((n) => WRITE_VERBS.some((verb) => n.includes(verb)));
    expect(writeTools).toEqual([]);
    await client.close();
  });

  test("MCP 로 find_instructors 를 부르면 { data, sources } 가 오고, 모르는 칸(memberId)은 INVALID_INPUT 으로 거부된다", async () => {
    const client = await connectedClient();
    const ok = await client.callTool({ name: "find_instructors", arguments: { name: "김하나", limit: 5 } });
    expect(ok.isError).not.toBe(true);
    const content = ok.content as { type: string; text: string }[];
    const payload = JSON.parse(content[0]?.text ?? "{}") as { data: unknown; sources: { kind: string; id: string }[] };
    const data = instructorCandidatesResultSchema.parse(payload.data);
    expect(data.resolution).toBe("ambiguous");
    expect(payload.sources.map((s) => s.kind)).toEqual(["instructor", "instructor"]);

    const bad = await client.callTool({ name: "find_instructors", arguments: { name: "김하나", limit: 5, memberId: randomUUID() } });
    expect(bad.isError).toBe(true);
    const badContent = bad.content as { type: string; text: string }[];
    expect(JSON.parse(badContent[0]?.text ?? "{}")).toEqual({ code: "INVALID_INPUT" });

    const academies = await client.callTool({ name: "find_academies", arguments: { name: "댄스온", limit: 5 } });
    const academyPayload = JSON.parse((academies.content as { text: string }[])[0]?.text ?? "{}") as { data: unknown };
    expect(academyCandidatesResultSchema.parse(academyPayload.data).resolution).toBe("ambiguous");
    await client.close();
  });
});
