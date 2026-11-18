// 강사 앱 화면 공통 틀 — I2 의 상태바·뒤로 버튼·하단 탭을 복제하고 제목은 새로 쓴다
function PAGE(name,minX,title,H=928,opts={}){
 const y0=24300;let x=6200; // 2026-11-13 재배치: 강사 기둥(x 6200) 아래 임시 줄. minX 인자는 위치에 쓰지 않는다
 const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
 while(roots.some(r=>r.x<x+390&&r.x+r.width>x&&r.y<y0+H&&r.y+r.height>y0))x+=440;
 const B=BOARD(name,x,y0,390,H);
 const put=(src)=>{const rx=src.x-S.x,ry=src.y-S.y;const c=src.clone();B.appendChild(c);c.x=B.x+rx;c.y=B.y+ry;return c;};
 const kids=S.children;const scr=kids.find(c=>c.name==='screen');
 for(const k of kids){if(k.name!=='screen'&&!k.name.startsWith('tabbar'))put(k);}
 const nav=put(scr.children.find(c=>c.name==='topnav'));
 const texts=[];const walk=s=>{for(const c of (s.children||[])){if(c.type==='text')texts.push(c);else walk(c);}};walk(nav);
 let tx=68,ty=36;for(const t of texts){if(t.characters==='수업 만들기'){tx=Math.round(t.x-B.x);ty=Math.round(t.y-B.y);t.remove();}else if(t.characters==='1 / 2'){t.remove();}}
 T(B,tx,ty,title,17,'800');
 if(opts.tab!==false){const tb=kids.find(c=>c.name.startsWith('tabbar'));const t=tb.clone();B.appendChild(t);t.x=B.x;t.y=B.y+H-84;}
 return B;}
function CHECK(B,x,y,on,dim){R(B,x,y,22,22,on?C.plum:'#ffffff',{r:7,stroke:on?null:(dim?'#e3ddd5':'#cfc8c0'),sw:1.5});if(on)T(B,x,y+2,'✓',12,'800','#ffffff',{w:22,align:'center'});}
