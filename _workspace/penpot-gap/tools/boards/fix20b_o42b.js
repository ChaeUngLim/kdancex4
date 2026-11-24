// O42B 대표 앱 · 질문 고치기 (O42 의 「고치기」를 누르면 오는 화면 · 초안을 고쳐 승인)
const B=PAGE_O('O42B · 대표 앱 · 질문 고치기 (O42 고치기 다음 · 답 초안을 고쳐서 승인 · 승인한 답만 AI 가 씀 · 환불 공지가 바뀌면 다시 볼 표시)',3080,'질문 고치기');
T(B,20,94,'수업 환불은 언제까지 되나요?',16,'800',C.ink,{w:350});
CHIP(B,20,126,'11번 물었어요',C.plumL,C.plum,12);
T(B,20,168,'AI 가 쓴 답 초안을 고쳐 주세요',12,'600',C.ink3);
// 고칠 수 있는 입력칸 — 테두리를 강조색으로 해 편집 중임을 보인다
R(B,20,192,350,190,C.input,{r:14,stroke:C.selLine,sw:1.5,name:'input:답 고치기'});
T(B,34,206,'환불은 수업 시작 24시간 전까지 신청할 수 있어요. 결제 수단에 따라 처리 기간이 달라요. 자세한 비율은 학원 환불·취소 공지를 확인해 주세요.',14,'500',C.ink,{w:322});
T(B,34,358,'118 / 500자',11,'500',C.ink3,{w:322,align:'right'});
R(B,20,398,350,64,C.plumL,{r:12,name:'box · 안내'});
T(B,34,410,'승인하면 이 답이 AI 안내에 쓰여요. 환불 공지가 바뀌면 다시 볼 표시가 붙어요.',11,'500',C.plum,{w:322});
BTN(B,20,778,'취소','ghost',{w:110,h:54,r:18,fs:15});
BTN(B,140,778,'고쳐서 승인','primary',{w:230,h:54,r:18,fs:15});
const root=penpot.currentPage.root.children;const f=p=>root.find(s=>s.type==='board'&&s.name.startsWith(p)&&!/이전 안|폐기/.test(s.name));
// O42 의 「고치기」 두 개를 이 화면으로 잇는다
const o42=f('O42 ·');let n=0;
const w=s=>{for(const c of (s.children||[])){if(c.name==='btn:고치기'){c.addInteraction('click',{type:'navigate-to',destination:B});n++;}w(c);}};if(o42)w(o42);
return [B.id,n];
