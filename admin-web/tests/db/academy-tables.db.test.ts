// S1-1.1(학원·대표·지점 테이블 묶음) — 입점 승인 트랜잭션(계약 07)이 한 번에 만드는 세 표가
// 실제 PostgreSQL 에서 설계(data-model §7-3·§7-9)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① academies 입점 칸 — 판매자 정보·승인 시각은 NOT NULL, 참고 칸은 NULL 허용, 기본값(status=active·card_payment_enabled=false)
//   ② academies 값 규칙 — 상태 4종·등록 형태 4종만, 사업자등록번호는 숫자 10자리만(ck_academies_brn)
//   ③ academy_branches — 없는 학원을 가리키면 FK 위반, 한 학원 안 지점 이름 중복 거부(uq_branches_academy_name)
//   ④ academy_owners — 학원당 활성 대표 1명(uq_academy_owners_active): 2명째 거부, 물러난(ended) 뒤엔 새 대표 가능
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("학원·대표·지점 표(academies 입점 칸·academy_owners·academy_branches)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 학원·계정 id — 끝나고 이것만 지운다.
  const academyA = randomUUID();
  const academyB = randomUUID();
  const ownerOne = randomUUID();
  const ownerTwo = randomUUID();
  const createdAcademies: string[] = [academyA, academyB];

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  // NOT NULL 위반은 constraint 칸이 없어서 오류 코드(23502)와 칸 이름으로 본다.
  async function expectError(run: Promise<unknown>, expected: { constraint?: string; code?: string; column?: string }) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; code?: string; column?: string; message?: string },
    );
    expect(error, `${JSON.stringify(expected)} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    if (expected.constraint) expect(error?.constraint ?? error?.message).toContain(expected.constraint);
    if (expected.code) expect(error?.code).toBe(expected.code);
    if (expected.column) expect(error?.column).toBe(expected.column);
  }

  // 학원 한 줄을 넣는다. 덮어쓸 칸만 넘기면 나머지는 테스트 기본값(ACADEMY_SELLER_VALUES 와 같은 값)이다.
  const insertAcademy = (id: string, overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id,
      name: "입점 시험 학원",
      region_sido: "서울",
      region_gu: "마포구",
      registration_type: "academy",
      business_name: "입점 시험 상호",
      representative_name: "시험 대표",
      business_registration_number: "1234567890",
      business_address: "서울 마포구 시험로 1",
      phone: "02-000-0000",
      approved_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
    // undefined 로 넘긴 칸은 빼서 「그 칸을 안 넣었을 때」를 시험한다.
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    const params = cols.map((k) => row[k]);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(`INSERT INTO academies (${cols.join(", ")}) VALUES (${marks})`, params);
  };

  const insertBranch = (academyId: string, name: string) =>
    q(
      `INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at)
       VALUES (uuidv7(), $1, $2, '서울 마포구 시험로 1', '서울', '마포구', now())`,
      [academyId, name],
    );

  const insertOwner = (academyId: string, accountId: string, status = "active") =>
    q(
      `INSERT INTO academy_owners (id, academy_id, staff_account_id, status, ended_at)
       VALUES (uuidv7(), $1, $2, $3, $4) RETURNING id`,
      [academyId, accountId, status, status === "ended" ? new Date() : null],
    );

  beforeAll(async () => {
    handle = openTestDb();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES}),
              ($2, '학원 B', '서울', '강남구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyA, academyB],
    );
    for (const id of [ownerOne, ownerTwo]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 대표', now())", [
        id,
        `academy-tables-${id}`,
      ]);
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 지점·대표 → 계정·학원.
    await q("DELETE FROM academy_branches WHERE academy_id = ANY($1)", [createdAcademies]);
    await q("DELETE FROM academy_owners WHERE academy_id = ANY($1)", [createdAcademies]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[ownerOne, ownerTwo]]);
    await q("DELETE FROM academies WHERE id = ANY($1)", [createdAcademies]);
    await closeTestDb(handle);
  });

  test("① academies 입점 칸 — 판매자 정보·승인 시각은 NOT NULL, 참고 칸은 NULL 허용", async () => {
    const { rows } = await q(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'academies'`,
    );
    const byName = new Map(rows.map((r: { column_name: string; is_nullable: string; data_type: string }) => [r.column_name, r]));
    const notNull = [
      "status",
      "registration_type",
      "business_name",
      "representative_name",
      "business_registration_number",
      "business_address",
      "phone",
      "card_payment_enabled",
      "approved_at",
    ];
    const nullable = [
      "registration_verified_at",
      "industry_code",
      "mail_order_report_number",
      "platform_fee_exempt_until",
      "business_status",
      "business_status_checked_at",
      "tagline",
      "intro",
    ];
    for (const c of notNull) expect(byName.get(c)?.is_nullable, c).toBe("NO");
    for (const c of nullable) expect(byName.get(c)?.is_nullable, c).toBe("YES");
    expect(byName.get("card_payment_enabled")?.data_type).toBe("boolean");
    expect(byName.get("platform_fee_exempt_until")?.data_type).toBe("date");
    expect(byName.get("approved_at")?.data_type).toBe("timestamp with time zone");
  });

  test("① 기본값 — 새 학원은 status=active, 카드 결제는 꺼진 채로 시작한다", async () => {
    const { rows } = await q("SELECT status, card_payment_enabled FROM academies WHERE id = $1", [academyA]);
    expect(rows[0]).toEqual({ status: "active", card_payment_enabled: false });
  });

  test("① 판매자 정보를 빼면 학원 행을 만들 수 없다(입점 승인 때만 생기는 표)", async () => {
    for (const column of ["business_name", "representative_name", "business_registration_number", "registration_type", "approved_at"]) {
      await expectError(insertAcademy(randomUUID(), { [column]: undefined }), { code: "23502", column });
    }
  });

  test("② 상태·등록 형태는 정해진 값만 받는다", async () => {
    await expectError(insertAcademy(randomUUID(), { status: "closed" }), { constraint: "academies_status_check" });
    await expectError(insertAcademy(randomUUID(), { registration_type: "online" }), {
      constraint: "academies_registration_type_check",
    });
    // 정해진 값 4종은 모두 들어간다.
    for (const type of ["academy", "tutoring_center", "sports_facility", "unregistered"]) {
      const id = randomUUID();
      createdAcademies.push(id);
      await insertAcademy(id, { registration_type: type, status: type === "unregistered" ? "restricted" : "active" });
    }
  });

  test("② 사업자등록번호는 숫자 10자리만 — 하이픈·자리 수가 틀리면 거부(ck_academies_brn)", async () => {
    for (const bad of ["123-45-67890", "123456789", "12345678901", "12345abcde", ""]) {
      await expectError(insertAcademy(randomUUID(), { business_registration_number: bad }), {
        constraint: "ck_academies_brn",
      });
    }
  });

  test("③ 지점 — 없는 학원을 가리키면 FK 위반", async () => {
    await expectError(insertBranch(randomUUID(), "본점"), { constraint: "academy_branches_academy_id_fkey" });
  });

  test("③ 지점 — 한 학원 안에서 이름이 겹치면 거부, 다른 학원은 같은 이름 가능", async () => {
    await insertBranch(academyA, "본점");
    await insertBranch(academyA, "홍대점");
    await expectError(insertBranch(academyA, "본점"), { constraint: "uq_branches_academy_name" });
    await insertBranch(academyB, "본점");
    const { rows } = await q("SELECT count(*)::int AS n FROM academy_branches WHERE academy_id = ANY($1)", [[academyA, academyB]]);
    expect(rows[0].n).toBe(3);
  });

  test("④ 대표 — 학원당 활성 대표 2명째는 거부한다(uq_academy_owners_active)", async () => {
    await insertOwner(academyA, ownerOne);
    await expectError(insertOwner(academyA, ownerTwo), { constraint: "uq_academy_owners_active" });
    const { rows } = await q("SELECT count(*)::int AS n FROM academy_owners WHERE academy_id = $1 AND status = 'active'", [academyA]);
    expect(rows[0].n).toBe(1);
  });

  test("④ 대표 — 옛 대표를 ended 로 닫으면 새 대표를 들일 수 있고, 한 대표가 여러 학원을 가질 수 있다", async () => {
    await q("UPDATE academy_owners SET status = 'ended', ended_at = now() WHERE academy_id = $1 AND status = 'active'", [academyA]);
    await insertOwner(academyA, ownerTwo);
    // 같은 사람(ownerTwo)이 학원 B 의 대표도 된다 — 한 대표가 여러 학원은 허용(7-12 ④).
    await insertOwner(academyB, ownerTwo);
    const { rows } = await q(
      "SELECT academy_id, status FROM academy_owners WHERE academy_id = ANY($1) ORDER BY started_at, status",
      [[academyA, academyB]],
    );
    expect(rows.filter((r: { status: string }) => r.status === "active")).toHaveLength(2);
    expect(rows.filter((r: { status: string }) => r.status === "ended")).toHaveLength(1);
  });
});
