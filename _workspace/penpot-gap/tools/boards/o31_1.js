const B=PAGE_O('O31 · 대표 앱 · 학원 탭 · 강사 수업 등록 권한 (O7 대체 · 강사마다 토글로 켜고 끔 · 켠 강사가 올린 수업도 대표 승인 뒤 공개 · 끄면 바로 막힘 · 관리자 웹 권한은 웹에서)',3080,'학원');
{const nav=B.children.find(c=>c.name==='topnav');const ws=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')ws.push(c);else walk(c);}};if(nav)walk(nav);for(const t of ws){if(t.characters==='‹')t.remove();}
 const tt=B.children.filter(c=>c.type==='text'&&c.characters==='학원').pop();if(tt)tt.x=B.x+20;}
R(B,20,94,350,40,'#ffffff',{r:12,stroke:C.line,name:'seg'});
T(B,20,104,'회원',13,'600',C.ink3,{w:116,align:'center'});
R(B,138,98,114,32,C.plumL,{r:10,name:'seg:on'});
T(B,138,104,'강사',13,'800',C.plum,{w:114,align:'center'});
T(B,254,104,'정산',13,'600',C.ink3,{w:116,align:'center'});
T(B,20,154,'소속 강사 3명 · 수업 등록 권한',14,'800');
T(B,20,178,'켠 강사는 우리 학원 이름으로 수업을 올릴 수 있어요',11,'500',C.ink3,{w:350});
return B.id;
