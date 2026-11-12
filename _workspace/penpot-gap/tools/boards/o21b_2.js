const B=FIND('O21B ·');
for(const s of [...B.children]){if(Math.round(s.y-B.y)>=160)s.remove();}
let y=166;
y+=ITEM(B,y,'pay','결제','김서연 · 90,000원 결제 완료','바차타 센슈얼 입문 · 카드 · 남은 자리 남 2 · 여 1',null,'10:12',true);
y+=ITEM(B,y,'warn','입금','주문과 다른 금액이 입금됐어요','박민지 · 살사 온원 입문 · 주문 160,000원, 입금 150,000원. 예약은 확정되지 않았고 전액 돌려줄 대상이에요','주문 보기 ›','09:48',true);
y+=ITEM(B,y,'warn','실패','최도윤 · 카드 결제가 실패했어요','살사 온투 기초 · 자리는 잡히지 않았어요',null,'09:20',true);
y+=ITEM(B,y,'sel','마감','바차타 센슈얼 입문 · 여 자리 마감','대기 2명 · 취소가 나오면 대기 1번에게 먼저 알려요','명단 보기 ›','08:55',false);
B.setPluginData('y',String(y));
return y;
