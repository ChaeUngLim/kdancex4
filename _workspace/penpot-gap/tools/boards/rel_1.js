// W3b: 회차마다 받는 사람 수 + 명단 보기, 아래 안내 문구 교체
const B=penpot.currentPage.getShapeById('4b8e03f2-3b91-8089-8008-eb0d17224d41');
const at=(x,y)=>B.children.filter(s=>s.type==='text'&&Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===y);
[...at(600,422),...at(292,628)].forEach(s=>s.remove());
T(B,600,422,'예약한 회원에게 휴강 알림이 가요',12,'500',C.ink3);
T(B,904,326,'예약한 9명에게 강사 변경 알림 · 명단 보기 ▾',12,'700',C.plum,{w:320,align:'right'});
T(B,904,422,'예약한 7명에게 휴강 알림 · 명단 보기 ▾',12,'700',C.plum,{w:320,align:'right'});
T(B,292,628,'대체·휴강·폐강한 회차를 예약한 회원에게 알림이 가요. 대체 강사에게는 배정 알림이 가요. 보내기 전에 받는 사람 명단을 한 번 더 보여 드려요',12,'500',C.ink3,{w:930});
return B.id;
