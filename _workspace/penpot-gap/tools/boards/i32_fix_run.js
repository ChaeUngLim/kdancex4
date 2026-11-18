
const ITEMS=[["I32", "d967fc", [[".*", "커플"]]], ["I32", "ef6931", [[".*", "열정적인"]]], ["I32", "29db71", [[".*", "빨간 조명"]]], ["I32", "667662", [[".*", "스튜디오"]]], ["I32", "6eb109", [[".*", "커플이 스튜디오에서 빨간 조명 아래 열정적으로 쌈바를 추는 모습"]]], ["I32", "f2a836", [[".*", "33 / 200"]]]];const out=[];
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
for(const [bn,suf,reps] of ITEMS){
  const B=penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith(bn+' ·')&&!s.name.includes('이전 안'));
  const t=B&&walk(B,[]).find(c=>c.id.endsWith(suf));
  if(!t){out.push([bn,suf,'없음']);continue;}
  let nv=t.characters; for(const [re,r] of reps){ nv = re==='.*'? r : nv.replace(new RegExp(re),r); }
  const x=t.x,y=t.y,w=t.width,h=t.height,fs=t.fontSize,fw=t.fontWeight,al=t.align,lh=t.lineHeight;
  const col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||'#141216';const parent=t.parent;
  const n=penpot.createText(nv);parent.appendChild(n);n.name='t:'+nv.slice(0,12);
  Object.assign(n,FONT);n.fontSize=String(fs);n.fontWeight=String(fw);n.fontVariantId=String(fw);n.growType='fixed';if(lh)n.lineHeight=String(lh);if(al)n.align=al;
  const longest=Math.max(...nv.split('\n').map(l=>tw(l,Number(fs))));const nl=nv.split('\n').length;
  const lines=Math.max(nl,Math.ceil(longest/Math.max(w,40)));
  const nw=(al==='center'||al==='right')?w:Math.max(w,lines>nl?w:longest);
  n.resize(nw,Math.max(h,Math.ceil(Number(fs)*1.5*lines)));n.x=x;n.y=y;
  n.fills=[{fillColor:col,fillOpacity:1}];n.getRange(0,nv.length).fills=[{fillColor:col,fillOpacity:1}];
  t.remove(); out.push([bn,nv.slice(0,30)]);
}
return out;
