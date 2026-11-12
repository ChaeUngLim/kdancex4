// 회원 앱 화면 공통 틀 — M9 의 상태바·뒤로 버튼·회원 하단 탭을 복제하고 제목은 새로 쓴다.
// slot 은 새 회원 보드 줄(y=ROW_Y, x=3080 부터)에서 왼쪽부터 몇 번째 칸인지(0부터). 칸마다 440px.
const ROW_Y=13100;
function PAGE_M(name,slot,title,H=928,opts={}){
 const S=FIND('M9 · 결제');
 const B=BOARD(name,3080+slot*440,ROW_Y,390,H);
 const put=(src)=>{const rx=src.x-S.x,ry=src.y-S.y;const c=src.clone();B.appendChild(c);c.x=B.x+rx;c.y=B.y+ry;return c;};
 const kids=S.children;const scr=kids.find(c=>c.name==='screen');
 put(kids.find(c=>c.name==='status'));
 const nav=put(scr.children.find(c=>c.name==='topnav'));
 const texts=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')texts.push(c);else walk(c);}};walk(nav);
 let tx=68,ty=36;for(const t of texts){if(t.characters==='결제하기'){tx=Math.round(t.x-B.x);ty=Math.round(t.y-B.y);t.remove();}}
 T(B,tx,ty,title,17,'800');
 if(opts.tab!==false){const tb=kids.find(c=>c.name.startsWith('tabbar')).clone();B.appendChild(tb);tb.x=B.x;tb.y=B.y+H-84;}
 return B;}
function CHECK(B,x,y,on,dim){R(B,x,y,22,22,on?C.plum:'#ffffff',{r:7,stroke:on?null:(dim?'#e3ddd5':'#cfc8c0'),sw:1.5});if(on)T(B,x,y+2,'✓',12,'800','#ffffff',{w:22,align:'center'});}
