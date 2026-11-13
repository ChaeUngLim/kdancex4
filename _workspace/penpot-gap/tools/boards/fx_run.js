
const ITEMS=[["O42", "ba6ef7", [[".*", "학원 환불·취소 공지 기준이에요. 수강 시작 전 100%, 총 기간 1/3 지나기 전 67%, 1/2 지나기 전 50%를 돌려드려요."]]], ["O46", "0e9aa5", [["11월분", "10월분"]]], ["O46", "1e8a4e", [["11/15 \\(토\\)", "10/25 (일)"]]]];const out=[];
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
