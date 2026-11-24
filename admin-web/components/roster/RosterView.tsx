import "temporal-polyfill/full/global";
import Link from "next/link";

import type { RosterPageData, RosterTab } from "../../lib/server/roster-page";
import type { AcademyMemberRow } from "../../lib/server/services/academy-members";
import {
  AGE_BAND_LABELS,
  GENDER_LABELS,
  MARKED_BY_LABELS,
  absenceWindow,
  genresText,
  inquiryText,
  sessionHeading,
  sessionSubline,
  sessionTabLabel,
  shortKst,
  termsText,
} from "../../lib/roster-view";
import { AbsenceMarkButton } from "./AbsenceMarkButton";
import { ContactReveal } from "./ContactReveal";
import { OnsiteHeadcountCard } from "./OnsiteHeadcountCard";
import styles from "./roster.module.css";

type ViewState = { sessionId: string | null; tab: RosterTab; q: string; memberId: string | null };

/** 화면 주소 만들기 — 회차 · 탭 · 검색어 · 연 회원을 주소에 남긴다(새로 고쳐도, 링크를 보내도 같은 화면) */
function hrefOf(academyId: string, state: ViewState): string {
  const query = new URLSearchParams();
  if (state.sessionId !== null) query.set("sessionId", state.sessionId);
  if (state.tab === "all") query.set("tab", "all");
  if (state.q !== "") query.set("q", state.q);
  if (state.memberId !== null) query.set("member", state.memberId);
  const text = query.toString();
  return `/academies/${encodeURIComponent(academyId)}/roster${text === "" ? "" : `?${text}`}`;
}

/** 명단 한 줄에 그릴 값 — 「이 회차」 탭은 회차 명단 + 회원 목록 정보, 「전체 회원」 탭은 회원 목록 줄 그대로 */
type Row = {
  memberId: string;
  nickname: string;
  gender: "male" | "female";
  ageBand: string;
  info: AcademyMemberRow | undefined;
  /** 이 회차 상태 — 결석 표시가 있으면 누가 했는지, 결제 완료면 「결제 · 앱」, 이 회차와 상관없으면 null */
  thisSession: { kind: "absent"; by: "member" | "instructor" | "owner" | null } | { kind: "paid" } | { kind: "refunded" } | { kind: "none" };
  /** 「결석 표시」 버튼을 붙일 수 있는 줄(이 회차 결제 완료 + 아직 결석 표시 없음) */
  canMark: boolean;
};

function rowsOf(data: RosterPageData, tab: RosterTab): Row[] {
  if (tab === "session") {
    return (data.roster?.members ?? []).map((m) => ({
      memberId: m.memberId,
      nickname: m.nickname,
      gender: m.gender,
      ageBand: m.ageBand,
      info: data.memberInfo[m.memberId],
      thisSession: m.absence === null ? { kind: "paid" } : { kind: "absent", by: m.absence.markedByKind },
      canMark: m.absence === null,
    }));
  }
  return data.allMembers.map((m) => {
    const state = m.thisSession;
    const thisSession: Row["thisSession"] =
      state === undefined || state.state === "none"
        ? { kind: "none" }
        : state.state === "refunded"
          ? { kind: "refunded" }
          : state.absencePlanned
            ? { kind: "absent", by: null }
            : { kind: "paid" };
    return {
      memberId: m.memberId,
      nickname: m.nickname,
      gender: m.gender,
      ageBand: m.ageBand,
      info: m,
      thisSession,
      canMark: thisSession.kind === "paid",
    };
  });
}

function ThisSessionCell({ value }: { value: Row["thisSession"] }) {
  if (value.kind === "absent") {
    return (
      <span className={styles.badgeAbsent} title={value.by === null ? undefined : MARKED_BY_LABELS[value.by]}>
        결석 예정
      </span>
    );
  }
  if (value.kind === "paid") return <span className={styles.cellText}>결제 · 앱</span>;
  if (value.kind === "refunded") return <span className={styles.cellText}>환불</span>;
  return <span className={styles.whoSub}>이 회차 아님</span>;
}

/**
 * 예약·명단 화면(보드 W6) 본문 — 서버가 미리 받은 회차·명단·회원 정보로 그린다(서버 컴포넌트).
 * 버튼이 있는 세 조각(현장 인원 `− n +` · 결석 표시 · 연락처 전체 보기)만 클라이언트 컴포넌트다.
 * 대표와 위임 강사(roster_manage, 보드 W23)가 같은 화면을 쓴다 — 위임 강사에게는 서버가 문의 칸을 내리지 않아 「문의」 열이 빠지고,
 * 연락처 전체 보기는 대표만(계약 18 §5 규칙 5).
 */
export function RosterView({
  academyId,
  data,
  state,
  isOwner,
}: {
  academyId: string;
  data: RosterPageData;
  state: ViewState;
  isOwner: boolean;
}) {
  const { pick, roster } = data;
  const current = pick.current;
  const now = Temporal.Instant.from(data.now);
  const sessionIdOrNull = current?.sessionId ?? null;
  const go = (patch: Partial<ViewState>) => hrefOf(academyId, { ...state, sessionId: sessionIdOrNull, ...patch });
  const rows = rowsOf(data, state.tab);
  // 문의 열은 대표 응답에만 칸이 있다(위임 강사 응답에는 openInquiries 키가 없다 — 계약 §3-1)
  const showInquiries = isOwner;
  const markWindow = current === null ? "before" : absenceWindow(current, now);
  const editable =
    roster !== null && roster.sessionStatus === "scheduled" && Temporal.Instant.compare(now, Temporal.Instant.from(roster.endsAt)) < 0;
  const awaitingTotal = roster === null ? 0 : Object.values(roster.awaitingPayment).reduce((sum: number, n) => sum + (n ?? 0), 0);

  return (
    <div className={styles.page}>
      <div>
        <h1 className={styles.title}>예약 · 명단</h1>
        <p className={styles.subtitle}>현장·전화로 받은 인원은 여기서 넣어요 · 앱 남은 자리와 결제 버튼에 바로 반영돼요</p>
      </div>

      {/* 회차 고르기 — ‹ › 는 학원 전체 회차를 시간 순서로, 「오늘」「이번 주」는 그 범위의 첫 회차로 옮긴다 */}
      <nav className={styles.picker} aria-label="회차 고르기">
        {pick.prev === null ? (
          <span className={styles.arrowOff} aria-hidden="true">‹</span>
        ) : (
          <Link className={styles.arrow} href={go({ sessionId: pick.prev.sessionId, memberId: null })} aria-label="이전 회차">
            ‹
          </Link>
        )}
        <div className={styles.sessionText}>
          <p className={styles.sessionTitle} data-testid="session-heading">
            {current === null ? "보여 줄 회차가 없어요" : sessionHeading(current)}
          </p>
          {current !== null && <p className={styles.sessionSub}>{sessionSubline(current)}</p>}
        </div>
        {pick.next === null ? (
          <span className={styles.arrowOff} aria-hidden="true">›</span>
        ) : (
          <Link className={styles.arrow} href={go({ sessionId: pick.next.sessionId, memberId: null })} aria-label="다음 회차">
            ›
          </Link>
        )}
        <div className={styles.chips}>
          {pick.todayTarget === null ? (
            <span className={styles.chipOff} title="오늘은 수업이 없어요">오늘</span>
          ) : (
            <Link className={pick.activeChip === "today" ? styles.chipOn : styles.chip} href={go({ sessionId: pick.todayTarget.sessionId, memberId: null })}>
              오늘
            </Link>
          )}
          {pick.weekTarget === null ? (
            <span className={styles.chipOff} title="이번 주는 수업이 없어요">이번 주</span>
          ) : (
            <Link className={pick.activeChip === "week" ? styles.chipOn : styles.chip} href={go({ sessionId: pick.weekTarget.sessionId, memberId: null })}>
              이번 주
            </Link>
          )}
        </div>
      </nav>

      {roster === null ? (
        <section className={styles.emptyCard} data-testid="roster-empty">
          <h2 className={styles.seatTitle}>아직 게시된 수업의 회차가 없어요</h2>
          <p className={styles.footNote}>수업을 올려 승인되면 회차마다 명단과 현장 인원을 여기서 볼 수 있어요.</p>
        </section>
      ) : (
        <OnsiteHeadcountCard
          // 저장 뒤 서버 값이 바뀌면 카드를 새로 시작한다(고치던 값이 옛 서버 값과 섞이지 않게)
          key={`${roster.sessionId}:${roster.seats.map((s) => s.onsite).join(",")}`}
          classId={roster.classId}
          sessionId={roster.sessionId}
          seats={roster.seats}
          editable={editable}
          awaitingPayment={awaitingTotal}
        />
      )}

      <section className={styles.card} data-testid="member-list">
        <div className={styles.listHead}>
          <h2 className={styles.seatTitle}>회원 명단</h2>
          {roster !== null && (
            <Link className={state.tab === "session" ? styles.chipOn : styles.chip} href={go({ tab: "session", q: "", memberId: null })}>
              {sessionTabLabel(roster.seats)}
            </Link>
          )}
          <Link className={state.tab === "all" ? styles.chipOn : styles.chip} href={go({ tab: "all", memberId: null })} data-testid="tab-all">
            전체 회원 {data.memberTotal}명
          </Link>
          {/* 검색 — 닉네임, 숫자 4자리면 연락처 뒷자리(계약 §3-1). 주소의 q 로 서버가 다시 읽는다 */}
          <form className={styles.search} action={`/academies/${encodeURIComponent(academyId)}/roster`} method="get">
            {sessionIdOrNull !== null && <input type="hidden" name="sessionId" value={sessionIdOrNull} />}
            <input type="hidden" name="tab" value="all" />
            <input className={styles.searchInput} name="q" defaultValue={state.q} placeholder="이름·연락처 뒷 4자리로 찾기" aria-label="회원 찾기" />
          </form>
        </div>

        {rows.length === 0 ? (
          <p className={styles.empty}>
            {state.tab === "session" ? "이 회차에 결제를 마친 수강생이 아직 없어요." : state.q !== "" ? `「${state.q}」에 맞는 회원이 없어요.` : "아직 이 학원에서 결제한 회원이 없어요."}
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>회원</th>
                <th>관심 장르</th>
                <th>수강 이력</th>
                <th>이 회차</th>
                {showInquiries && <th>문의</th>}
                <th>결석 표시</th>
                <th aria-label="상세" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const open = row.info?.openInquiries;
                return (
                  <tr key={row.memberId} className={row.memberId === state.memberId ? styles.rowSelected : undefined} data-testid={`member-row-${row.nickname}`}>
                    <td>
                      <div className={styles.who}>
                        <span className={styles.avatar} />
                        <div>
                          <p className={styles.nickname}>{row.nickname}</p>
                          <p className={styles.whoSub}>
                            {GENDER_LABELS[row.gender]} · {AGE_BAND_LABELS[row.ageBand] ?? row.ageBand}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className={styles.cellText}>{row.info === undefined ? "—" : genresText(row.info.interestGenres)}</td>
                    <td className={styles.cellText}>{row.info === undefined ? "—" : termsText(row.info.completedTerms)}</td>
                    <td>
                      <ThisSessionCell value={row.thisSession} />
                    </td>
                    {showInquiries && (
                      <td className={typeof open === "number" && open > 0 ? styles.inquiryOpen : styles.cellText}>{inquiryText(open)}</td>
                    )}
                    <td>
                      {row.canMark && current !== null ? (
                        <AbsenceMarkButton
                          classId={current.classId}
                          sessionId={current.sessionId}
                          memberId={row.memberId}
                          nickname={row.nickname}
                          markWindow={markWindow}
                        />
                      ) : (
                        <span className={styles.whoSub}>
                          {row.thisSession.kind !== "absent" ? "—" : row.thisSession.by === null ? "결석 예정" : MARKED_BY_LABELS[row.thisSession.by]}
                        </span>
                      )}
                    </td>
                    <td>
                      <Link className={styles.more} href={go({ memberId: row.memberId })} aria-label={`${row.nickname} 상세`}>
                        ›
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {state.tab === "all" && data.allMembersHasMore && (
          <p className={styles.footNote}>앞의 100명만 보여요 — 이름이나 연락처 뒷 4자리로 찾아 주세요.</p>
        )}
        <div className={styles.listFoot}>
          <p className={styles.footNote}>
            {awaitingTotal > 0 ? `결제 대기 ${awaitingTotal}명은 결제를 마치면 이름이 보여요 · ` : ""}줄 끝 › 를 누르면 그 회원의 수강·결석 예정 이력을 봐요
          </p>
          <p className={styles.footNote}>결석 표시를 누르면 회원에게 「결석으로 표시됐어요」 알림이 가요 · 누가 언제 표시했는지 남아요</p>
        </div>
      </section>

      {data.detail !== null && (
        <section className={styles.detail} data-testid="member-detail" aria-label="회원 상세">
          <div className={styles.detailHead}>
            <span className={styles.avatar} />
            <div>
              <h2 className={styles.detailName}>{data.detail.nickname}</h2>
              <p className={styles.whoSub}>
                {GENDER_LABELS[data.detail.gender]} · {AGE_BAND_LABELS[data.detail.ageBand] ?? data.detail.ageBand} · 관심 장르{" "}
                {genresText(data.detail.interestGenres)}
              </p>
            </div>
            <Link className={styles.button} style={{ marginLeft: "auto" }} href={go({ memberId: null })}>
              닫기
            </Link>
          </div>
          <div className={styles.detailGrid}>
            <div>
              <p className={styles.detailLabel}>연락처</p>
              {isOwner ? (
                <ContactReveal
                  key={data.detail.memberId}
                  academyId={academyId}
                  memberId={data.detail.memberId}
                  sessionId={sessionIdOrNull}
                  phoneMasked={data.detail.phoneMasked}
                />
              ) : (
                <p className={styles.detailValue} data-testid="phone-masked">
                  {data.detail.phoneMasked}
                </p>
              )}
              {data.detail.inquiries !== undefined && (
                <>
                  <p className={styles.detailLabel}>문의</p>
                  <p className={styles.detailValue}>
                    {data.detail.inquiries === null ? "—" : data.detail.inquiries.length === 0 ? "없음" : `${data.detail.inquiries.length}건`}
                  </p>
                </>
              )}
            </div>
            <div>
              <p className={styles.detailLabel}>수강 이력</p>
              {data.detail.enrollments.length === 0 ? (
                <p className={styles.footNote}>없음</p>
              ) : (
                <ul className={styles.historyList}>
                  {data.detail.enrollments.map((e) => (
                    <li key={e.offeringId + e.label}>
                      <b>{e.classTitle}</b> · {e.label}
                      {/* 판매 단위 이름에 이미 「5회」가 있으면 겹쳐 적지 않는다 */}
                      {e.label.includes(`${e.sessionCount}회`) ? "" : ` · ${e.sessionCount}회`}
                      {e.paidAt === null ? "" : ` · ${shortKst(e.paidAt)} 결제`}
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.detailLabel}>결석 예정 이력</p>
              {data.detail.absenceHistory.length === 0 ? (
                <p className={styles.footNote}>없음</p>
              ) : (
                <ul className={styles.historyList}>
                  {data.detail.absenceHistory.map((a) => (
                    <li key={a.sessionId}>
                      {shortKst(a.startsAt)} 회차 · {MARKED_BY_LABELS[a.markedByKind]}({shortKst(a.markedAt)})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
