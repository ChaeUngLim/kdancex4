// 학원 행을 직접 넣는 테스트·시드가 함께 쓰는 「입점 칸」 기본값.
//
// 왜 필요한가: S1-1.1(학원·대표·지점 테이블 묶음)부터 academies 는 입점 승인 때만 생기는 표라
// 판매자 정보(등록 형태·상호·대표자명·사업자등록번호·주소·전화)와 승인 시각이 NOT NULL 이다(data-model §7-3).
// 학원을 부모 행으로만 쓰는 테스트는 이 값에 관심이 없으므로, 같은 기본값을 한곳에서 붙여 넣게 했다.
// 쓰는 법: `INSERT INTO academies (..., ${ACADEMY_SELLER_COLUMNS}) VALUES (..., ${ACADEMY_SELLER_VALUES})`
//   — 값은 SQL 리터럴이라 자리표시자($1…) 번호를 건드리지 않는다.

/** 입점 때 반드시 채우는 academies 칸 이름(쉼표로 이어 붙인 SQL 조각) */
export const ACADEMY_SELLER_COLUMNS =
  "registration_type, business_name, representative_name, business_registration_number, business_address, phone, approved_at";

/** 위 칸에 넣는 테스트용 값 — 사업자등록번호는 ck_academies_brn(숫자 10자리)을 통과하는 형식이다. */
export const ACADEMY_SELLER_VALUES =
  "'academy', '테스트 상호', '테스트 대표', '1234567890', '서울 마포구 테스트로 1', '02-000-0000', now()";
