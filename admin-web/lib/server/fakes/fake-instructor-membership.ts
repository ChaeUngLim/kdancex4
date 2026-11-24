// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — InstructorMembershipPort 의 가짜 구현.
//
// 강사 멤버십 표(S6-1.2)가 생기기 전까지 쓴다. 판정은 「기본값 + 예외 목록」 하나다.
//   - defaultMember: 목록에 없는 강사의 답. 기본 true — 실제 서비스도 강사 계정이 생기면 1년 체험이 붙어(FR-112e)
//     베타 기간에는 거의 모든 강사가 멤버십 상태이기 때문이다.
//   - except: 기본값과 **반대로** 답할 강사 계정 id 들.
// 개발 서버(deps.ts)는 환경 변수 FAKE_INSTRUCTOR_NON_MEMBER_IDS(쉼표로 이은 강사 계정 id)를 except 로 넘겨,
// 시연 강사 몇 명을 「멤버십 아님」으로 둔다. 테스트는 이 클래스를 직접 만들어 넘긴다.
import type { InstructorMembershipPort } from "../ports/instructor-membership";

export type FakeInstructorMembershipOptions = {
  readonly defaultMember?: boolean;
  readonly except?: Iterable<string>;
};

export class FakeInstructorMembership implements InstructorMembershipPort {
  readonly #defaultMember: boolean;
  #except: ReadonlySet<string>;
  #calls: string[] = [];

  constructor(options: FakeInstructorMembershipOptions = {}) {
    this.#defaultMember = options.defaultMember ?? true;
    this.#except = new Set(options.except ?? []);
  }

  /** 한 강사의 답을 정한다(테스트에서 멤버십이 끝난 상황을 만들 때). 집합은 새로 만들어 바꾼다 */
  set(staffAccountId: string, member: boolean): this {
    const next = new Set(this.#except);
    // 기본값과 같은 답이면 예외 목록에서 빼고, 다르면 넣는다
    if (member === this.#defaultMember) next.delete(staffAccountId);
    else next.add(staffAccountId);
    this.#except = next;
    return this;
  }

  /** isInstructorMember 가 불린 계정 id(순서대로) */
  get calls(): readonly string[] {
    return [...this.#calls];
  }

  async isInstructorMember(staffAccountId: string): Promise<boolean> {
    this.#calls = [...this.#calls, staffAccountId];
    return this.#except.has(staffAccountId) ? !this.#defaultMember : this.#defaultMember;
  }
}

/** 환경 변수 값(쉼표로 이은 id) → id 목록. 빈 칸·공백은 버린다 */
export function parseInstructorIdList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}
