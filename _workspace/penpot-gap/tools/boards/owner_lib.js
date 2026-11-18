// 대표 앱 화면 공통 틀 — O21 의 상태바 글자·뒤로(‹)·대표 하단 탭을 복제하고 제목은 새로 쓴다.
// 대표 앱 줄(y=22576)에서 minX 부터 빈 자리를 찾아 놓는다. 내용은 y 94~(H-100) 안에 둔다.
function PAGE_O(name,minX,title,H=928,opts={}){
 const y0=24300;let x=12400; // 2026-11-13 재배치: 대표 앱 기둥(x 12400) 아래 임시 줄. minX 인자는 위치에 쓰지 않는다
 const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
 while(roots.some(r=>r.x<x+390&&r.x+r.width>x&&r.y<y0+H&&r.y+r.height>y0))x+=440;
 const B=BOARD(name,x,y0,390,H);
 const put=(src)=>{const rx=src.x-S.x,ry=src.y-S.y;const c=src.clone();B.appendChild(c);c.x=B.x+rx;c.y=B.y+ry;return c;};
 const kids=S.children;put(kids[0]);
 const scr=kids.find(c=>c.name==='screen');
 const nav=put(scr.children.find(c=>c.name==='topnav'));
 const texts=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')texts.push(c);else walk(c);}};walk(nav);
 for(const t of texts){if(t.characters==='알림'||t.characters==='모두 읽음')t.remove();}
 T(B,46,49,title,20,'800');
 if(opts.tab!==false){const tb=kids.find(c=>c.name.startsWith('tabbar')).clone();B.appendChild(tb);tb.x=B.x;tb.y=B.y+H-84;}
 return B;}
function CHECK(B,x,y,on,dim){R(B,x,y,22,22,on?C.plum:'#ffffff',{r:7,stroke:on?null:(dim?'#e3ddd5':'#cfc8c0'),sw:1.5});if(on)T(B,x,y+2,'✓',12,'800','#ffffff',{w:22,align:'center'});}
