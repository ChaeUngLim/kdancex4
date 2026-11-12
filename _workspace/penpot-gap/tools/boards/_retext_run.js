
const ITEMS=[{"board": "W11", "old": "60%", "new": "정한 비율"}, {"board": "W11", "old": "60%", "new": "정한 비율"}, {"board": "O26", "old": "정산 완료 560,000 · 강사 몫 60%", "new": "정산 완료 560,000 · 학원과 정한 비율"}, {"board": "O26", "old": "정산 완료 490,000 · 강사 몫 60%", "new": "정산 완료 490,000 · 학원과 정한 비율"}];const out=[];
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
for(const it of ITEMS){
  const B=penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith(it.board+' ·')&&!s.name.includes('이전 안'));
  if(!B){out.push([it.board,'보드 없음']);continue;}
  const t=walk(B,[]).find(c=>(c.characters||'').startsWith(it.old));
  if(!t){out.push([it.board,'글 없음',it.old.slice(0,20)]);continue;}
  const x=t.x,y=t.y,w=t.width,h=t.height,fs=t.fontSize,fw=t.fontWeight,al=t.align,lh=t.lineHeight;
  const col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||'#141216';const parent=t.parent;
  const n=penpot.createText(it.new);parent.appendChild(n);n.name='t:'+it.new.slice(0,12);
  try{if(parent.flex)n.layoutChild.absolute=true;}catch(e){}
  Object.assign(n,FONT);n.fontSize=String(fs);n.fontWeight=String(fw);n.fontVariantId=String(fw);n.growType='fixed';if(lh)n.lineHeight=String(lh);if(al)n.align=al;
  const need=tw(it.new,Number(fs));const lines=Math.max(1,Math.ceil(need/Math.max(w,40)));
  n.resize(Math.max(w,lines>1?w:need),Math.max(h,Math.ceil(Number(fs)*1.5*lines)));n.x=x;n.y=y;
  n.fills=[{fillColor:col,fillOpacity:1}];n.getRange(0,it.new.length).fills=[{fillColor:col,fillOpacity:1}];
  if(parent.flex){t.opacity=0;}else{t.remove();}
  out.push([it.board,'ok',lines]);
}
return out;
