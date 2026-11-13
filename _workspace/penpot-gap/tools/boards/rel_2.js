// W3b2 틀: W3b 를 복제해 셋째 회차를 폐강으로 고른 상태로 만들고 어둡게 덮는다
const src=penpot.currentPage.getShapeById('4b8e03f2-3b91-8089-8008-eb0d17224d41');
const B=src.clone(); B.name='W3b2 · 소속 해제 확인 창 (보낼 알림·받는 회원 명단 확인 · 회원 빼기 없음 · 여러 회차 예약자는 한 번에 모아 보냄)'; B.x=9310; B.y=23700;
const sh=(x,y)=>B.children.filter(s=>Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===y);
const on=sh(600,282).find(s=>s.type==='rectangle'), off=sh(808,474).find(s=>s.type==='rectangle');
off.fills=on.fills; off.strokes=on.strokes;
[...sh(600,518),...sh(932,686)].filter(s=>s.type==='text').forEach(s=>s.remove());
T(B,600,518,'예약한 회원에게 폐강 알림과 환불 안내가 가요',12,'500',C.ink3);
T(B,904,518,'예약한 5명에게 폐강 알림 · 명단 보기 ▾',12,'700',C.plum,{w:320,align:'right'});
const btn=sh(1040,672).find(s=>s.type==='rectangle'); btn.fills=[{fillColor:C.plum,fillOpacity:1}];
R(B,0,0,1280,764,'#1d1820',{op:.5,name:'dim'});
CARD(B,330,36,620,692,{r:20});
T(B,362,64,'알림을 보내고 소속을 해제할까요?',20,'800');
T(B,362,96,'박서윤 강사 · 차차차 입문 회차 3개 · 보내기 전에 받는 사람을 확인해 주세요',13,'500',C.ink3,{w:560});
return B.id;
