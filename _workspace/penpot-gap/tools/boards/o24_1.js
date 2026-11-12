const B=PAGE_O('O24 · 대표 앱 · 수업 탭 (우리 학원 수업 목록 · 정규·이벤트형·승인 대기 칩 · 줄을 누르면 수업 상세 O8 · 행사는 신청 명단 O27 · 등록·수정은 관리자 웹)',3080,'수업');
{const nav=B.children.find(c=>c.name==='topnav');const ws=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')ws.push(c);else walk(c);}};if(nav)walk(nav);for(const t of ws){if(t.characters==='‹')t.remove();}
 const tt=B.children.filter(c=>c.type==='text'&&c.characters==='수업').pop();if(tt)tt.x=B.x+20;}
let cx=20;[['전체 9',true],['정규 6',false],['이벤트형 2',false],['승인 대기 1',false]].forEach(([s,on])=>{cx+=CHIP(B,cx,96,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2,12)+8;});
R(B,20,136,350,72,C.warnL,{r:16,name:'승인 대기'});
T(B,36,148,'승인 대기 · 쌈바(입문)',14,'800',C.warn);
T(B,36,172,'이준호 강사 등록 · 월·수 20:30 · 12/7부터 8회',12,'500',C.ink2,{w:290});
T(B,346,158,'›',16,'700',C.warn);
T(B,20,228,'정규',13,'800');
return B.id;
