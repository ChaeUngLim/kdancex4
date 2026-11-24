// W27B 3/3 — 오른쪽 상세 카드 + 연결(W31·W27)
const B=FIND('W27B ·');
CARD(B,948,224,300,522,{r:18});
T(B,968,244,'김서연 · 바차타 워크숍',15,'800',C.ink);
T(B,968,268,'이벤트 10/20 · 35,000원 · 간편 계좌이체',11,'500',C.ink3);
T(B,968,306,'접수',12,'700',C.ink);T(B,968,324,'10/13 · 마감 10일 전',11,'500',C.ink3);
T(B,968,356,'적용 규정',12,'700',C.ink);T(B,968,374,'마감 10일 전 · 100% 환불',11,'500',C.ink3);
T(B,968,414,'환불액',12,'700',C.ink);
INPUT(B,968,434,260,'35,000원',{h:40,fw:'800'});
T(B,968,482,'규정대로 미리 채웠어요 · 대표는 올리기만 할 수 있어요',11,'500',C.ink3,{w:260});
R(B,968,520,260,1,C.line);
T(B,968,534,'계좌 결제분은 계좌 환불 송금으로 이어져요',12,'700',C.plum,{w:260});
BTN(B,968,630,'계좌 환불 송금으로 ›','primary',{w:260,h:44,r:14,fs:13});
BTN(B,968,682,'환불 실행 · 카드 결제분','ghost',{w:260,h:44,r:14,fs:13});
const root=penpot.currentPage.root.children;const f=p=>root.find(s=>s.type==='board'&&s.name.startsWith(p)&&!/이전 안|폐기/.test(s.name));
const w31=f('W31 ·'),w27=f('W27 ·');
const rect=B.children.find(c=>c.name==='btn:계좌 환불 송금으로 ›');if(rect&&w31)rect.addInteraction('click',{type:'navigate-to',destination:w31});
const tab=B.children.find(c=>c.name==='chip:정규형 3');if(tab&&w27)tab.addInteraction('click',{type:'navigate-to',destination:w27});
// W27 의 「이벤트형 2」 탭에서 W27B 로 들어오는 길
const t2=w27.children.find(c=>c.name==='chip:이벤트형 2');if(t2)t2.addInteraction('click',{type:'navigate-to',destination:B});
return [B.id,!!rect,!!tab,!!t2];
