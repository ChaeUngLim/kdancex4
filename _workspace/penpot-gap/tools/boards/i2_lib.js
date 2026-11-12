// 강사 수업 만들기 2단계 보드 공통 — I2 에서 상태바·상단·하단 탭을 가져온다
function SHELL(name,minX){
 const S=FIND('I2 · 수업 만들기');const y0=Math.round(S.y);let x=minX;
 const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
 while(roots.some(r=>r.x<x+390&&r.x+r.width>x&&r.y<y0+928&&r.y+r.height>y0))x+=440;
 const B=BOARD(name,x,y0,390,928);
 const put=(src)=>{const rx=src.x-S.x,ry=src.y-S.y;const c=src.clone();B.appendChild(c);c.x=B.x+rx;c.y=B.y+ry;return c;};
 const kids=S.children;const scr=kids.find(c=>c.name==='screen');
 for(const k of kids){if(k.name!=='screen'&&!k.name.startsWith('tabbar'))put(k);}
 const nav=put(scr.children.find(c=>c.name==='topnav'));
 const find=(s)=>{for(const c of (s.children||[])){if(c.type==='text'&&c.characters==='1 / 2')return c;const r=find(c);if(r)return r;}return null;};
 const step=find(nav);let sx=330,sy=39;if(step){sx=Math.round(step.x-B.x);sy=Math.round(step.y-B.y);step.remove();}
 T(B,sx,sy,'2 / 2',13,'700',C.ink3);
 const tb=kids.find(c=>c.name.startsWith('tabbar'));const t=tb.clone();B.appendChild(t);t.x=B.x;t.y=B.y+928-84;
 return B;}
function STEP(B,x,y,label,val){R(B,x,y,167,56,'#ffffff',{r:16,stroke:C.line});T(B,x+16,y+17,label,14,'700');
 R(B,x+62,y+12,30,32,C.input,{r:9,stroke:C.line});T(B,x+62,y+16,'−',16,'700',C.ink,{w:30,align:'center'});
 T(B,x+94,y+16,val,15,'800',C.ink,{w:32,align:'center'});
 R(B,x+128,y+12,30,32,C.input,{r:9,stroke:C.line});T(B,x+128,y+16,'+',16,'700',C.ink,{w:30,align:'center'});}
