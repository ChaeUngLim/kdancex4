const O=FIND('O21 ·');
let x=2640;const y0=22576;const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
while(roots.some(r=>r.x<x+390&&r.x+r.width>x&&r.y<y0+980&&r.y+r.height>y0))x+=440;
const B=BOARD('O21B · 대표 알림함 · 결제·운영 알림 (결제 확인 · 다른 금액 입금 · 결제 실패 · 정원 마감 · 취소·신청 급증 · 강의실 충돌 · 강사 일정 변경)',x,y0,390,980);
const put=(src,px,py)=>{const c=src.clone();B.appendChild(c);c.x=B.x+px;c.y=B.y+py;return c;};
put(O.children[0],24,6);
const screen=O.children.find(c=>c.name==='screen');
put(screen.children.find(c=>c.name==='topnav'),20,42);
let cx=20;for(const [k,on] of [['전체',true],['승인',false],['신청·마감',false],['문의',false],['정산',false],['운영',false]]){const w=tw(k,12)+18;R(B,cx,94,w,32,on?C.sel:'#ffffff',{r:16,stroke:on?C.selLine:C.line,name:'chip:'+k});T(B,cx,101,k,12,on?'700':'600',on?C.ink:'#4e4853',{w,align:'center'});cx+=w+5;}
T(B,20,138,'오늘',12,'700',C.ink3);
R(B,20,166,350,2,'#ffffff');
let y=168;
y+=ITEM(B,y,'pay','결제','김서연 · 90,000원 결제 완료','바차타 센슈얼 입문 · 카드 · 남은 자리 남 2 · 여 1',null,'10:12',true);
y+=ITEM(B,y,'warn','입금','주문과 다른 금액이 입금됐어요','박민지 · 살사 온원 입문 · 주문 160,000원, 입금 150,000원. 예약은 확정되지 않았고 전액 돌려줄 대상이에요','주문 보기 ›','09:48',true);
y+=ITEM(B,y,'warn','실패','최도윤 · 카드 결제가 실패했어요','살사 온투 기초 · 자리는 잡히지 않았어요',null,'09:20',true);
y+=ITEM(B,y,'sel','마감','바차타 센슈얼 입문 · 여 자리 마감','대기 2명 · 취소가 나오면 대기 1번에게 먼저 알려요','명단 보기 ›','08:55',false);
return [B.id,x,y];
