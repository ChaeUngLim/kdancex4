# 방식 A 구현 레퍼런스 — 원클릭 송금 딥링크 + 알림톡

- 날짜: 2026-09-14
- 관련 정책: `docs/payment-method-policy.md`의 "결제수단 라우팅 규칙 — 방식 A / 방식 B"
- 성격: 사용자가 제공한 구현 참고 코드 모음. **아직 프로젝트 코드베이스에 반영되지 않은 참고자료**이며, Phase 5(구현) 착수 시 이 문서를 출발점으로 실제 코드를 작성한다. 여기 있는 코드는 예시이지 최종 구현이 아니다(예: API 키 하드코딩, 에러 핸들링 없음 등은 그대로 쓰면 안 됨).

> ⛔ **2026-09-25 폐기 — 딥링크(방식 A)를 없애고 모든 결제를 PG 로 통일했다**(spec FR-110(PG 단일 결제 경로)). 이 문서의 태스크·코드는 착수하지 않는다. SCH-13~20(외부 계정·승인 절차 ~ 딥링크 테스트)도 `_workspace/SCH_kdance.html` 에서 폐기로 표시했다. 기록으로만 남긴다.

## 1. 송금 딥링크 생성 (토스 / 카카오페이 / 네이버페이)

카카오톡 알림톡 버튼 규격상 `supertoss://` 같은 커스텀 스킴을 버튼의 직접 링크(URL)로 넣으면 **카카오 승인 심사에서 거절될 수 있다.** 따라서 서버에서 리다이렉트 처리해주는 웹페이지를 중간 매개체로 둔다(§2). 3개 간편송금 앱(토스/카카오페이/네이버페이) 중 사용자가 선택하게 하면 결제 완료율이 높아진다는 것이 이 레퍼런스의 제안이다.

```python
from urllib.parse import urlencode

def generate_toss_deeplink(bank_name: str, account_no: str, amount: int, memo: str = "") -> str:
    """
    토스(Toss) 원클릭 송금 딥링크 생성
    :param bank_name: 은행명 (예: 신한, 국민, 기업, 카카오)
    :param account_no: 계좌번호 (하이픈 제외 숫자만)
    :param amount: 입금 금액
    :param memo: 받는사람 통장 표시 메모 (선택)
    """
    clean_account = account_no.replace("-", "")
    params = {"bank": bank_name, "accountNo": clean_account, "amount": amount}
    if memo:
        params["msg"] = memo
    return f"supertoss://send?{urlencode(params)}"


def generate_kakaopay_deeplink(bank_name: str, account_no: str, amount: int) -> str:
    """카카오페이 송금 딥링크 생성"""
    clean_account = account_no.replace("-", "")
    params = {
        "action": "pay_send",
        "bank_name": bank_name,
        "account_number": clean_account,
        "amount": amount,
    }
    return f"kakaotalk://kakaopay/money/to/bank?{urlencode(params)}"


def generate_naverpay_deeplink(bank_name: str, account_no: str, amount: int, memo: str = "") -> str:
    """
    네이버페이(NaverPay) 송금 딥링크 생성
    :param bank_name: 은행명 (예: 기업, 신한, 국민, 카카오뱅크)
    :param account_no: 계좌번호 (하이픈 제외 숫자만)
    :param amount: 입금 금액
    :param memo: 메모/주문번호 (선택)
    """
    clean_account = account_no.replace("-", "")
    params = {"action": "remittance", "bankName": bank_name, "accountNo": clean_account, "amount": amount}
    if memo:
        params["memo"] = memo
    return f"naverpayapp://remittance?{urlencode(params)}"


# --- 사용 예시 ---
order_id = "ORD-20260914-01"
price = 45000

toss_url = generate_toss_deeplink("기업", "1234567890123", price, order_id)
# supertoss://send?bank=%EA%B8%B0%EC%97%85&accountNo=1234567890123&amount=45000&msg=ORD-20260914-01

kakao_url = generate_kakaopay_deeplink("기업", "1234567890123", price)
# kakaotalk://kakaopay/money/to/bank?action=pay_send&bank_name=%EA%B8%B0%EC%97%85&account_number=1234567890123&amount=45000

naver_pay_url = generate_naverpay_deeplink("기업", "1234567890123", price, order_id)
# naverpayapp://remittance?action=remittance&bankName=%EA%B8%B0%EC%97%85&accountNo=1234567890123&amount=45000&memo=ORD-20260914-01
```

## 2. 중간 브릿지 페이지 (Deep Link Redirect, 3-provider 분기)

알림톡 버튼에는 이 리다이렉트 엔드포인트 URL을 넣는다. 접속 시 선택된 provider(`toss`/`kakao`/`naver`)의 앱 스킴을 즉시 실행하고, 미설치 시(또는 2초 내 미반응 시) 대체 안내로 대피한다.

```python
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get("/pay/redirect/{order_id}", response_class=HTMLResponse)
async def pay_redirect(order_id: str, provider: str = "toss"):
    # DB에서 order_id 기반 입금 금액 및 계좌 정보를 불러왔다고 가정
    bank = "기업"
    account = "1234567890123"
    amount = 45000

    if provider == "toss":
        deeplink = generate_toss_deeplink(bank, account, amount, order_id)
    elif provider == "kakao":
        deeplink = generate_kakaopay_deeplink(bank, account, amount)
    elif provider == "naver":
        deeplink = generate_naverpay_deeplink(bank, account, amount, order_id)
    else:
        deeplink = generate_toss_deeplink(bank, account, amount, order_id)  # 기본값

    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>결제 페이지로 이동 중</title>
        <script>
            window.location.href = "{deeplink}";

            // 2초 후 앱이 안 열리면 기본 입금안내로 이동
            setTimeout(function() {{
                alert("앱 실행에 실패했습니다. 아래 계좌로 직접 입금해 주세요.\\n{bank}은행 {account}");
            }}, 2000);
        </script>
    </head>
    <body>
        <p>결제 앱으로 이동하고 있습니다...</p>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)
```

⚠️ 예시 코드 그대로 쓰면 안 되는 부분: 계좌 정보가 하드코딩돼 있다(실제로는 order_id로 DB 조회), `alert()`는 브라우저 환경에서만 동작(모바일 웹뷰 대응 필요), 2초 타임아웃 값은 검증되지 않은 임의값, `provider` 파라미터에 대한 화이트리스트 검증 없음(현재는 else로 안전하게 폴백).

## 3. 알림톡 발송 (SOLAPI)

SOLAPI(구 쿨SMS)를 통해 원클릭 이체 링크가 포함된 카카오톡 알림톡을 발송하는 예시. HMAC-SHA256 서명 인증을 사용한다.

```python
import hmac
import hashlib
import time
import uuid
import requests

# SOLAPI 개발자 센터 발급 정보 — 실제로는 환경변수/시크릿 매니저에서 로드할 것
API_KEY = "YOUR_API_KEY"
API_SECRET = "YOUR_API_SECRET"
PF_ID = "YOUR_KAKAO_CHANNEL_PF_ID"        # 카카오톡 비즈니스 채널 PFID
TEMPLATE_ID = "YOUR_APPROVED_TEMPLATE_ID"  # 승인받은 알림톡 템플릿 ID


def get_solapi_header():
    """HMAC-SHA256 인증 헤더 생성"""
    date = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    salt = str(uuid.uuid4()).replace('-', '')
    signature = hmac.new(
        API_SECRET.encode('utf-8'),
        (date + salt).encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return {
        "Authorization": f"HMAC-SHA256 apiKey={API_KEY}, date={date}, salt={salt}, signature={signature}",
        "Content-Type": "application/json; charset=utf-8"
    }


def send_payment_alimtalk(receiver_phone: str, user_name: str, order_id: str, amount: int):
    """원클릭 송금 링크 포함 알림톡 발송"""
    url = "https://api.solapi.com/messages/v4/send"
    pay_url = f"https://yourdomain.com/pay/redirect/{order_id}?provider=toss"  # §2 브릿지 주소

    payload = {
        "message": {
            "to": receiver_phone,
            "kakaoOptions": {
                "pfId": PF_ID,
                "templateId": TEMPLATE_ID,
                "variables": {
                    "#{고객명}": user_name,
                    "#{금액}": f"{amount:,}",
                    "#{주문번호}": order_id,
                },
                "buttons": [
                    {"buttonType": "WL", "buttonName": "토스로 1초만에 송금하기", "linkMo": pay_url, "linkPc": pay_url}
                ],
            }
        }
    }
    response = requests.post(url, headers=get_solapi_header(), json=payload)
    return response.json()


# 실행 테스트
if __name__ == "__main__":
    res = send_payment_alimtalk(
        receiver_phone="01012345678", user_name="홍길동", order_id="ORD-20260914-01", amount=45000,
    )
    print(res)
```

⚠️ 이 예시를 실제 구현에 쓰려면 선행 필요: SOLAPI 가입·API 키 발급, 카카오톡 비즈니스 채널(PF) 개설, 알림톡 템플릿 사전 심사·승인. 전부 이번 대화에서 아직 진행되지 않은 외부 절차다.

## 4. 오픈뱅킹 입금 확인 (Popbill)

Popbill 계좌입금조회 API로 1~5분 간격 폴링해 입금 내역을 탐지, DB의 예약 상태를 `PAID`로 갱신. 구체 코드는 이번 대화에서 제공되지 않음 — T5(입금 확인 폴링) 구현 시 Popbill 공식 문서(`mcp__context7`로 조회 권장) 참조.

## 4-1. 3대 간편송금 특징 비교 + 알림톡 UX

| 수단 | 스킴 URL 기본 구조 | 특징 |
|---|---|---|
| 토스 | `supertoss://send?...` | 송금 이탈률이 가장 적고 딥링크 호환성이 가장 안정적 |
| 카카오페이 | `kakaotalk://kakaopay/money/to/bank?...` | 알림톡과 연결할 때 카카오 생태계 내 전환율이 매우 높음 |
| 네이버페이 | `naverpayapp://remittance?...` | 네이버쇼핑/네이버페이 위주 이용자층에 친숙함 |

**권장 UX:** 알림톡 한 건에 `[토스로 송금]` `[카카오로 송금]` `[네이버로 송금]` 3개 버튼을 나열(각각 §2 브릿지 URL의 `provider` 쿼리만 다르게)하면, 사용자가 평소 쓰는 앱으로 즉시 이동해 완료율이 올라간다는 것이 이 레퍼런스의 제안.

## 5. 미해결 — 방식 A(원클릭 송금 딥링크) 착수 전 확인 필요

- SOLAPI/Popbill 계정·API 키·카카오 비즈니스 채널·알림톡 템플릿 심사 — 전부 외부 절차이며 아직 준비되지 않았다.
- 리다이렉트 브릿지 페이지를 `admin-web`/`backend` 중 어디에 둘지 (위 예시는 FastAPI 엔드포인트 — backend가 유력).
- 3개 provider(토스/카카오페이/네이버페이) 전부 지원할지, 최소로 시작(예: 토스 1개)할지.
- 이 딥링크 방식이 "방식 A" 전용(저가·간헐적 상품)인지, 아니면 사용자가 언급한 "최종 권장 세팅"(카드 빌링 + 딥링크만, 방식 B/포트원 없이 모든 단건 예약에 적용)으로 대체됐는지 — `docs/payment-method-policy.md`에서 사용자 확인 대기 중.
