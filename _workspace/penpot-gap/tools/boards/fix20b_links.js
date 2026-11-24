const P=penpot.currentPage.root.children.filter(x=>x.type==='board'&&!/이전 안|폐기/.test(x.name));
const bd=n=>P.find(x=>x.name.startsWith(n+' ·'));
const out=[];
const all=b=>{const a=[];const w=s=>{for(const c of (s.children||[])){a.push(c);w(c);}};w(b);return a;};
// 보드 b 안에서 글자가 re 에 맞고(선택: y 범위) 의 도형을 찾아 눌렀을 때 to 보드로 가게 한다
const L=(b,re,to,o={})=>{const B=bd(b),D=bd(to);if(!B||!D){out.push(b+'→'+to+' 보드 없음');return;}
 let a=all(B).filter(s=>s.type==='text'&&re.test(s.characters)).map(s=>[s,Math.round(s.y-B.y),Math.round(s.x-B.x)]);
 if(o.y)a=a.filter(([s,y])=>Math.abs(y-o.y)<=4);if(o.x)a=a.filter(([s,y,x])=>Math.abs(x-o.x)<=4);
 a.sort((p,q)=>p[1]-q[1]);if(o.nth!==undefined)a=a.slice(o.nth,o.nth+1);
 if(!a.length){out.push(b+' '+re+' 없음');return;}
 a.forEach(([s])=>{(s.interactions||[]).slice().forEach(i=>s.removeInteraction(i));s.addInteraction('click',{type:'navigate-to',destination:D});});out.push(b+'→'+to+' ×'+a.length);};
// 강사 I6B 수업 관리 탭의 줄들
[['시간 · 장소 변경','I34',238],['휴강 알리기','I25',301],['오늘 결석자','I26',427],['대타 요청','I14',507],['현장 등록 · 정원','I22',581]].forEach(([t,to,y])=>{
 L('I6B',new RegExp('^'+t.replace(/[·]/g,'·')+'$'),to);L('I6B',/^›$/,to,{y,x:344});});
// 대표 앱
L('O5P',/눌러서 승인하기/,'O5');L('O5Q',/눌러서 승인·거/,'O37');
L('O21',/^확인하고 승인 ›/,'O5',{nth:0});L('O21',/^확인하고 승인 ›/,'O37',{nth:1});L('O21',/^신청 명단 ›/,'O27');L('O21',/^정산 요약 ›/,'O26');
L('O21B',/^주문 보기 ›/,'O45');L('O21B',/^명단 보기 ›/,'O27');L('O21B',/^신청 현황 ›/,'O27');L('O21B',/^수업 보기 ›/,'O8');
L('O36B',/^환불 요청 처리 열기/,'O48');
L('O6',/^승인 대기 1건/,'O5');L('O6',/^누르면 수업 승인 화면/,'O5');
L('O24',/^승인 대기 · 쌈바/,'O5');L('O24',/^›$/,'O5',{y:158});L('O24',/^신청 명단 ›/,'O27');
return out;
