// I28: 결제 회원 명단 보기 + 알림 안내
const B=penpot.currentPage.getShapeById('7e5bac36-3185-8087-8008-ed59c2941f0b');
const at=(x,y)=>B.children.filter(s=>s.type==='text'&&Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===y);
at(36,312).forEach(s=>s.remove());
T(B,36,312,'대체 강사는 대표가 정해요 · 정하면 10명에게 알림이 가요',11,'500',C.ink3,{w:318});
T(B,250,280,'명단 보기 ▾',12,'700',C.plum,{w:104,align:'right'});
T(B,20,668,'해제할 때 알림 받을 회원 명단을 한 번 더 보여 드려요. 회원을 빼고 보낼 수는 없어요.',11,'500',C.ink3,{w:350});
return B.id;
