// O48D 대표 앱 · 환불 완료 결과 (FR-295 · 확인 팝업 다음 화면)
const B=PAGE_O('O48D · 대표 앱 · 환불 완료 결과 (실행한 금액·회원·결제 수단 · 카드는 원거래 취소 · 회원에게 알림이 감 · 되돌릴 수 없음)',3080,'환불 요청');
R(B,155,130,80,80,C.plumL,{r:40,name:'완료 원'});
T(B,155,150,'✓',34,'800',C.plum,{w:80,align:'center'});
T(B,20,232,'107,200원을 환불했어요',20,'800',C.ink,{w:350,align:'center'});
T(B,20,266,'결제한 신용카드의 원거래를 취소했어요',13,'500',C.ink2,{w:350,align:'center'});
CARD(B,20,314,350,150,{r:16});
[['회원','김서연'],['수업','바차타 센슈얼 입문'],['환불액','107,200원'],['처리','11/10 (화) 15:42 · 대표']].forEach(([k,v],i)=>{const y=330+i*34;T(B,36,y,k,12,'600',C.ink3);T(B,150,y,v,13,'700',C.ink,{w:204,align:'right'});});
R(B,20,480,350,64,C.plumL,{r:12,name:'box · 알림'});
T(B,34,492,'회원에게 「환불이 끝났어요」 알림이 갔어요. 카드사에 따라 돌려받는 데 며칠 걸릴 수 있어요.',11,'500',C.plum,{w:322});
BTN(B,20,778,'다른 요청 보기','primary',{w:350,h:54,r:18,fs:15});
const root=penpot.currentPage.root.children;const f=p=>root.find(s=>s.type==='board'&&s.name.startsWith(p)&&!/이전 안|폐기/.test(s.name));
const b48=f('O48B ·');
// O48B 의 「지문으로 확인」 버튼에서 결과 화면으로 이어 준다
const btn=b48&&b48.children.find(c=>c.name==='btn:지문으로 확인');if(btn)btn.addInteraction('click',{type:'navigate-to',destination:B});
return [B.id,!!btn];
