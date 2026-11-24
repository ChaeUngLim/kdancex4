// O49B 대표 앱 · 강사 지급 승인 확인 팝업 (FR-133b · spec 807)
const B=PAGE_O('O49B · 대표 앱 · 강사 지급 승인 확인 팝업 (승인 버튼 뒤 한 번 더 · 금액·강사·지급 수단 다시 보기 · 보낸 뒤에는 되돌릴 수 없음)',3080,'강사 지급 승인');
R(B,0,0,390,928,'#1d1820',{op:.5,name:'막'});
R(B,24,250,342,400,'#ffffff',{r:24,name:'확인 상자'});
T(B,24,274,'609,210원을 지급할까요?',18,'800',C.ink,{w:342,align:'center'});
T(B,24,306,'11월분 · 강사 2명 · 정산일 12/5 (토)',13,'500',C.ink2,{w:342,align:'center'});
R(B,44,340,302,1,C.line);
T(B,44,354,'이준호 강사',13,'700');T(B,200,354,'324,912원',13,'700',C.ink,{w:146,align:'right'});
T(B,44,380,'김하나 강사',13,'700');T(B,200,380,'284,298원',13,'700',C.ink,{w:146,align:'right'});
R(B,44,410,302,1,C.line);
T(B,44,424,'지급 수단',12,'600',C.ink3);T(B,160,424,'PG 지급대행 · 강사 등록 계좌',12,'700',C.ink,{w:186,align:'right'});
R(B,44,458,302,52,C.warnL,{r:12,name:'경고'});
T(B,58,470,'보낸 뒤에는 되돌릴 수 없어요. 금액과 강사를 다시 확인해 주세요.',11,'700',C.warn,{w:274});
BTN(B,44,540,'취소','ghost',{w:140,h:48,r:16,fs:14});
BTN(B,196,540,'지급하기','primary',{w:150,h:48,r:16,fs:14});
const root=penpot.currentPage.root.children;const f=p=>root.find(s=>s.type==='board'&&s.name.startsWith(p)&&!/이전 안|폐기/.test(s.name));
const o49=f('O49 ·');const rr=o49&&o49.children.find(c=>c.type==='board'||c.type==='rectangle');
const btn=o49&&o49.children.find(c=>c.name==='btn:지문으로 확인하고 승인');if(btn)btn.addInteraction('click',{type:'navigate-to',destination:B});
return B.id;
