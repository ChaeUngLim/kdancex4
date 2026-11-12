const B=PAGE_O('O23 · 대표 앱 · 캘린더 탭 (우리 학원 전체 수업 일정 · 주 단위 · 강사별 칩 · 소속 강사의 다른 학원 일정은 「불가 시간」으로만 · 조회 전용)',3080,'캘린더');
// 탭 첫 화면이라 뒤로(‹)를 지우고 제목을 왼쪽으로 옮긴다
{const nav=B.children.find(c=>c.name==='topnav');const ws=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')ws.push(c);else walk(c);}};if(nav)walk(nav);for(const t of ws){if(t.characters==='‹')t.remove();}
 const tt=B.children.filter(c=>c.type==='text'&&c.characters==='캘린더').pop();if(tt)tt.x=B.x+20;}
CARD(B,20,94,350,92,{r:16});
T(B,36,106,'2026년 11월 · 이번 주',14,'800');
T(B,300,104,'‹',16,'700',C.ink3);T(B,336,104,'›',16,'700',C.ink3);
R(B,73,134,42,44,C.plum,{r:12,name:'고른 날'});
const D=['월','화','수','목','금','토','일'],N=['9','10','11','12','13','14','15'];
D.forEach((d,i)=>{const x=30+i*47;const on=i===1;T(B,x,136,d,11,'600',on?'#ffffff':C.ink3,{w:42,align:'center'});T(B,x,153,N[i],14,'800',on?'#ffffff':(i>4?C.ink3:C.ink),{w:42,align:'center'});});
let cx=20;[['전체 강사',true],['이준호',false],['김하나',false],['박서윤',false]].forEach(([s,on])=>{cx+=CHIP(B,cx,202,s,on?C.plum:'#ffffff',on?'#ffffff':C.ink2,12)+8;});
return B.id;
