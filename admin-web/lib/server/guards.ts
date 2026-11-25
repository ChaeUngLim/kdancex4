// S0-3.6(requireMember·requireStaff 가드) — 보호 경로의 맨 앞에서 「누가 부르는가」와 「해도 되는가」를 가른다.
//   계약: _workspace/03_contracts/README.md §2(회원 확인) · §6-2(requireStaff 판정 순서) · §6-4(직원 경로 오류 코드)
//   관련: FR-300(주소로 직접 들어가도 서버가 막는다) · FR-303(관리자 웹 2단계 인증) · FR-081a(위임 범위)
//
// 쓰는 법(Route Handler):
//   const guards = createGuards({ db, getSession: (h) => auth.api.getSession({ headers: h }) });
//   export const GET = withRoute(async (request, ctx) => {
//     const staff = await guards.requireStaff("roster_manage", { academyId, surface: "web", headers: request.headers });
//     …
//   });
// 실패하면 HttpError 를 던지고, withRoute 가 §4.8 모양(`{detail, code}`) 응답으로 바꾼다.
//
// 왜 권한을 세션에 담지 않고 매 요청 DB 에서 읽나(§6-2 머리말, O-11(위임 끄면 즉시 차단)):
//   세션에 넣어 두면 대표가 위임을 꺼도 그 세션이 끝날 때까지 강사가 명단을 볼 수 있다.
//   요청마다 읽으면 끈 바로 다음 요청부터 403 이 된다. 읽는 표는 색인이 걸린 작은 표 넷뿐이다.
//
// 이 파일은 DB 에서 「사실」만 읽어 Actor(lib/domain/permissions.ts 의 판정 입력)로 모은다.
// 자원 단위 판정(이 명단이 내 것인가 등)은 같은 Actor 로 `decide()` 를 불러 이어서 한다.
import type { Db } from "../../prisma/db";
import type { StaffRoleName } from "../domain/constants";
import { DELEGATION_PERMISSIONS, type Actor, type DelegationPermission } from "../domain/permissions";
import { HttpError } from "./http";

// ---- 입력 모양 -------------------------------------------------------------------------------

/** 어느 화면에서 왔나. 관리자 웹(web)만 2단계 인증을 요구한다 — 강사·대표 앱(app)은 묻지 않는다(FR-303). */
export type Surface = "web" | "app";

/**
 * 가드가 받는 권한 이름(§6-2 의 4·6·7번).
 *   admin                         — 운영자(role_grants)
 *   owner                         — 그 학원의 대표(academy_owners)
 *   roster_manage · class_manage  — 대표가 강사에게 켜 준 위임(instructor_delegations). 대표는 자동 통과
 */
export type StaffPermission = "admin" | "owner" | DelegationPermission;

/** 학원 단위 권한은 학원 id 가 꼭 있어야 한다 — 빠뜨리면 타입 검사에서 막힌다. */
type AcademyScopedPermission = Exclude<StaffPermission, "admin">;

export type RequireStaffOptions<P extends StaffPermission> = {
  surface: Surface;
  /** 요청 헤더(쿠키 또는 Authorization: Bearer). Route Handler 는 request.headers, 서버 컴포넌트는 await headers(). */
  headers: Headers;
} & (P extends AcademyScopedPermission ? { academyId: string } : { academyId?: string });

/**
 * 세션을 읽는 함수. 앱에서는 Better Auth 의 `auth.api.getSession({ headers })` 를 넘긴다.
 * 가드는 그중 사용자 id 와 2단계 인증 여부만 본다.
 *   user.twoFactorEnabled          — 계정이 지금 인증 앱을 켜 두었나
 *   session.secondFactorVerified   — 「이 세션」이 2단계를 거쳐 만들어졌나(S0-3.8, staff-auth.ts 의 세션 훅이 적는다)
 */
export type AuthSession = {
  user: { id: string; twoFactorEnabled?: boolean | null };
  session?: { secondFactorVerified?: boolean | null; appSession?: boolean | null } | null;
};

/**
 * S0-3.8(관리자 웹 2단계 인증 게이트) — 「2단계를 마친 세션」의 판정 기준 하나.
 * 둘 다 참이어야 한다:
 *   ① 세션이 2단계를 거쳐 만들어졌다 — 인증 앱 등록 전에 비밀번호만으로 만든 세션(다른 기기·앱 토큰)을 막는다
 *   ② 계정이 지금도 인증 앱을 켜 두었다 — 나중에 인증 앱을 끄면 예전 세션도 다시 2단계를 거쳐야 한다
 *   ③ (2026-11-25) 앱 로그인으로 만든 세션(appSession)이 아니다 — 앱 세션은 6자리를 거치지 않았으므로
 *      세션 훅이 어떤 이유로 secondFactorVerified 를 잘못 적어도 여기서 한 번 더 막는다(막는 쪽 이중 확인)
 * requireStaff(③)와 GET /api/staff/me 의 secondFactorVerified 가 같은 함수를 써서 서로 어긋나지 않는다.
 */
export function isSecondFactorVerified(session: AuthSession): boolean {
  return (
    session.user.twoFactorEnabled === true &&
    session.session?.secondFactorVerified === true &&
    session.session?.appSession !== true
  );
}
export type SessionReader = (headers: Headers) => Promise<AuthSession | null>;

export type GuardDeps = { db: Db; getSession: SessionReader };

// ---- 돌려주는 모양 ---------------------------------------------------------------------------

export type MemberContext = { authUserId: string; memberId: string };

/** 통과한 직원. `actor` 는 permissions.decide() 에 그대로 넘길 수 있다. */
export type StaffContext = {
  authUserId: string;
  staffAccountId: string;
  actor: Extract<Actor, { type: "staff" }>;
};

/**
 * 역할·권한을 묻지 않고 「켜진 직원 계정」만 확인한 결과(§6-2 의 ①②만). `GET /api/staff/me` 가 쓴다.
 * 2단계 인증 여부는 막지 않고 값으로 돌려준다 — 위임 없는 강사를 인증 앱 등록 전에 판정하려고(§6-1).
 */
export type StaffAccountContext = StaffContext & { displayName: string; secondFactorVerified: boolean };

// ---- 오류 문장(사람이 읽는 것) --------------------------------------------------------------

const DETAIL = {
  unauthenticated: "로그인이 필요해요",
  signupIncomplete: "가입을 마친 뒤 이용할 수 있어요",
  staffRequired: "직원 계정으로 로그인해 주세요",
  suspended: "이용이 정지된 계정이에요",
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  forbidden: "이 메뉴를 쓸 권한이 없어요",
  academyNotFound: "학원을 찾을 수 없어요",
} as const;

// UUID 모양(버전 무관). 모양이 틀린 id 를 DB 에 넘기면 형 변환 오류(500)가 나므로, 미리 걸러 「없음」(404)으로 답한다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isDelegationPermission = (p: StaffPermission): p is DelegationPermission =>
  (DELEGATION_PERMISSIONS as readonly string[]).includes(p);

// ---- 가드 ------------------------------------------------------------------------------------

export function createGuards({ db, getSession }: GuardDeps) {
  /** §6-2 ① · §2 — 세션이 없으면 401. 쿠키든 Bearer 토큰이든 Better Auth 가 같은 세션으로 읽는다. */
  async function readSession(headers: Headers): Promise<AuthSession> {
    const session = await getSession(headers);
    if (session === null) throw new HttpError("UNAUTHENTICATED", DETAIL.unauthenticated);
    return session;
  }

  /**
   * 회원 경로 가드(§2). 세션 → members.auth_user_id 로 회원을 찾는다.
   *   세션 없음 401 UNAUTHENTICATED · 세션은 있는데 회원 행이 없음(가입 미완료) 403 SIGNUP_INCOMPLETE
   */
  async function requireMember(request: { headers: Headers }): Promise<MemberContext> {
    const session = await readSession(request.headers);
    const [member] = await db.query(
      db.raw.sql`SELECT id FROM members WHERE auth_user_id = ${session.user.id}`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (member === undefined) throw new HttpError("SIGNUP_INCOMPLETE", DETAIL.signupIncomplete);
    return { authUserId: session.user.id, memberId: member.id };
  }

  /**
   * 직원 경로 가드(§6-2). 표의 순서대로 검사하고 **먼저 걸린 단계의 응답**을 그대로 던진다.
   * 순서가 곧 정보 노출 규칙이다 — 예를 들어 2단계 인증 전에는 학원이 있는지(404)조차 알려 주지 않는다.
   */
  async function requireStaff<P extends StaffPermission>(
    permission: P,
    options: RequireStaffOptions<P>,
  ): Promise<StaffContext> {
    // ①② 세션 + active 직원 계정
    const session = await readSession(options.headers);
    const account = await readActiveStaffAccount(session);

    // ③ 관리자 웹이면 2단계 인증을 마친 세션이어야 한다(FR-303). 기준은 isSecondFactorVerified 하나다.
    //   비밀번호만 낸 「1단계 세션」은 여기서 401 이 되어, 학원이 있는지(⑤ 404)조차 알려 주지 않는다.
    if (options.surface === "web" && !isSecondFactorVerified(session)) {
      throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    }

    // 판정에 쓸 사실을 한 번에 읽는다: 켜진 역할 · 대표인 학원 · 켜진 위임
    const actor = await loadStaffActor(account.id);

    // ④ 운영자 권한
    if (permission === "admin" && !actor.roles.includes("admin")) {
      throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }

    // ⑤ 학원이 있다. 없는 학원이면 404 — 다른 학원의 「있는」 id 는 ⑥·⑦ 에서 403 이 된다(§4 「404 로 숨기지 않는다」).
    const academyId = options.academyId;
    if (academyId !== undefined) await assertAcademyExists(academyId);

    // ⑥ 대표 권한 — academy_owners(active) 가 이 계정이어야 한다.
    const isOwner = academyId !== undefined && actor.ownedAcademyIds.includes(academyId);
    if (permission === "owner" && !isOwner) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    // ⑦ 위임 권한 — 대표는 자동 통과, 아니면 그 학원의 active 소속에 그 위임 행이 켜져 있어야 한다.
    if (isDelegationPermission(permission) && !isOwner) {
      const granted = academyId === undefined ? [] : (actor.delegations[academyId] ?? []);
      if (!granted.includes(permission)) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }

    // ⑧ 학원 상태 조건(restricted 학원의 새 게시 거부 등)은 경로마다 달라 각 라우트가 이어서 본다.
    return { authUserId: session.user.id, staffAccountId: account.id, actor };
  }

  /**
   * §6-2 ② — 세션의 사용자에게 직원 계정이 있고 active 다.
   * 회원 계정으로 들어오면 직원 계정이 없다(FR-011a — 둘은 다른 계정).
   */
  async function readActiveStaffAccount(session: AuthSession): Promise<{ id: string; displayName: string }> {
    const [account] = await db.query(
      db.raw.sql`SELECT id, status, display_name FROM staff_accounts WHERE auth_user_id = ${session.user.id}`
        .returnsRow({ id: "pg/uuid@1", status: "pg/text@1", display_name: "pg/text@1" })
        .build(),
    );
    // 탈퇴(withdrawn)한 계정은 「직원 계정이 없음」과 같게 본다. 정지(suspended)만 따로 알린다.
    if (account === undefined || account.status === "withdrawn") {
      throw new HttpError("STAFF_ACCOUNT_REQUIRED", DETAIL.staffRequired);
    }
    if (account.status !== "active") throw new HttpError("ACCOUNT_SUSPENDED", DETAIL.suspended);
    return { id: account.id, displayName: account.display_name };
  }

  /**
   * 권한을 묻지 않는 직원 확인(§6-2 ①②). 「내가 무엇을 할 수 있나」를 묻는 `GET /api/staff/me` 처럼
   * 판정 자체가 응답인 경로에서 쓴다. 다른 직원 경로는 반드시 requireStaff 를 쓴다.
   * 2단계 인증(③)은 막지 않고 secondFactorVerified 로 알려 준다 — 화면이 그 값으로 2단계 화면을 띄운다.
   */
  async function requireStaffAccount(request: { headers: Headers }): Promise<StaffAccountContext> {
    const session = await readSession(request.headers);
    const account = await readActiveStaffAccount(session);
    const actor = await loadStaffActor(account.id);
    return {
      authUserId: session.user.id,
      staffAccountId: account.id,
      displayName: account.displayName,
      // ③ 과 같은 기준
      secondFactorVerified: isSecondFactorVerified(session),
      actor,
    };
  }

  /** 없는 학원(또는 id 모양이 틀림)이면 404 NOT_FOUND. */
  async function assertAcademyExists(academyId: string): Promise<void> {
    if (!UUID_PATTERN.test(academyId)) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
    const [academy] = await db.query(
      db.raw.sql`SELECT id FROM academies WHERE id = ${academyId}::uuid`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (academy === undefined) throw new HttpError("NOT_FOUND", DETAIL.academyNotFound);
  }

  /**
   * 직원 한 명의 판정 사실을 DB 에서 모은다. 「지금 켜진 것」만 담는다 —
   * 취소된 역할(revoked)·끝난 대표(ended)·끝난 소속(released 등)의 위임은 넣지 않는다.
   */
  async function loadStaffActor(staffAccountId: string): Promise<StaffContext["actor"]> {
    const roleRows = await db.query(
      db.raw.sql`SELECT role FROM role_grants WHERE staff_account_id = ${staffAccountId} AND status = 'active'`
        .returnsRow({ role: "pg/text@1" })
        .build(),
    );
    const ownerRows = await db.query(
      db.raw.sql`SELECT academy_id FROM academy_owners WHERE staff_account_id = ${staffAccountId} AND status = 'active'`
        .returnsRow({ academy_id: "pg/uuid@1" })
        .build(),
    );
    // 위임은 소속을 거쳐 학원에 매인다. 소속이 active 일 때만 그 위임이 살아 있다.
    const delegationRows = await db.query(
      db.raw.sql`SELECT a.academy_id, d.permission
                 FROM instructor_affiliations a
                 JOIN instructor_delegations d ON d.affiliation_id = a.id
                 WHERE a.instructor_account_id = ${staffAccountId} AND a.status = 'active'`
        .returnsRow({ academy_id: "pg/uuid@1", permission: "pg/text@1" })
        .build(),
    );

    // 학원별 위임 목록으로 묶는다. 원본 행을 고치지 않고 새 객체를 만든다.
    // 웹 위임 2종만 담는다 — 앱 「수업 등록 권한」(class_submit)은 웹 메뉴를 열지 않는 별개 권한이다(S1-2.9, 08 열린 점 ①).
    const delegations = delegationRows
      .filter((row) => (DELEGATION_PERMISSIONS as readonly string[]).includes(row.permission))
      .reduce<Record<string, DelegationPermission[]>>(
        (acc, row) => ({ ...acc, [row.academy_id]: [...(acc[row.academy_id] ?? []), row.permission as DelegationPermission] }),
        {},
      );

    return {
      type: "staff",
      accountId: staffAccountId,
      roles: roleRows.map((r) => r.role as StaffRoleName),
      ownedAcademyIds: ownerRows.map((r) => r.academy_id),
      delegations,
    };
  }

  return { requireMember, requireStaff, requireStaffAccount };
}

export type Guards = ReturnType<typeof createGuards>;
