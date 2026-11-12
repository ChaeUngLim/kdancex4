const B=PAGE_O('O25 · 대표 앱 · 마이 탭 (계정 · 수업 관리 플러스 · 학원 페이지 수정 · 알림 설정 · 관리자 웹에서 하는 일 안내 · 운영자 문의 · 로그아웃)',3080,'마이');
{const nav=B.children.find(c=>c.name==='topnav');const ws=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')ws.push(c);else walk(c);}};if(nav)walk(nav);for(const t of ws){if(t.characters==='‹')t.remove();}
 const tt=B.children.filter(c=>c.type==='text'&&c.characters==='마이').pop();if(tt)tt.x=B.x+20;}
CARD(B,20,94,350,84,{r:16});
R(B,36,110,52,52,C.plum,{r:16,name:'학원 로고'});T(B,36,123,'L',20,'800','#ffffff',{w:52,align:'center'});
T(B,102,110,'라틴하우스 강남',16,'800');T(B,102,136,'대표 · 아이디 latinhouse_owner',12,'500',C.ink3);
CARD(B,20,194,350,72,{r:16});
T(B,36,206,'수업 관리 플러스',14,'800');T(B,36,230,'체험 중 · 일정 · 명단 기능을 모두 써요',12,'500',C.ink3);
CHIP(B,286,214,'체험 중',C.plumL,C.plum,11);
const M=[['학원 페이지 수정','사진 · 소개'],['알림 설정','승인 · 신청·마감 · 문의 · 정산 · 운영'],['운영자에게 문의','앱 · 결제 시스템 문제'],['약관 · 개인정보','입점 약관 · 동의 기록'],['로그아웃','']];
M.forEach(([t,s],i)=>{const y=290+i*58;T(B,20,y,t,14,'700',i===4?C.ink3:C.ink);if(s)T(B,20,y+22,s,11,'500',C.ink3);if(i<4)T(B,350,y+6,'›',15,'600',C.ink3);R(B,20,y+48,350,1,C.line);});
R(B,20,592,350,136,C.note,{r:16,stroke:C.line,name:'관리자 웹 안내'});
T(B,36,604,'관리자 웹에서 하는 일',13,'800');
T(B,36,628,'정산 상세 · 강사 지급 승인 · 환불 처리 · 정산 계좌 변경 · 이의 제기 · 행사 일괄 취소 · 수업 등록. PC 에서 같은 아이디로 로그인하고 2단계 인증을 거쳐요.',12,'500',C.ink2,{w:318});
return B.id;
