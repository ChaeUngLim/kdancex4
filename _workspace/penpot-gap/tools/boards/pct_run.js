
const ITEMS=[["W4a", "13a405", [["^전액$", "100%"]]], ["W4a", "045a83", [["^전액$", "100%"]]], ["W4a", "41b684", [["^2/3$", "67%"]]], ["W4a", "3aff0f", [["^2/3$", "67%"]]], ["W4a", "5435c9", [["^1/2$", "50%"]]], ["W4a", "1a6635", [["^2/3$", "67%"]]], ["W4a", "47b8c4", [["^반환 없음$", "0%"]]], ["W4a", "a4826d", [["^반환 없음$", "0%"]]], ["W4a", "d14dd0", [["^우리 학원$", "우리 학원 (%)"]]], ["W4a", "b3d32e", [[".*", "시작 전 100% · 1/3 전 67%\n1/2 전 67% · 1/2 뒤 0%"]]], ["W4a", "e15455", [[".*", "1/2 지나기 전 구간을 50%에서 67%로 올렸어요 · 법정 2/3 은 올려서 67%"]]], ["W21", "46355e", [["2/3을", "67%를"]]], ["W27", "f8cb82", [["2/3 반환", "67% 반환"]]], ["C15C", "bb2745", [["수강료의 2/3 반환", "수강료의 67% 반환"]]], ["I2D", "144f8c", [[".*", "시작 전 100% · 1/3 전 67%\n1/2 전 67% · 1/2 뒤 0%"]]], ["C25A", "e2e2dc", [[".*", "시작 전 100% · 1/3 지나기 전 67% · 1/2 지나기 전 50% · 1/2 지난 뒤 0%"]]]];const out=[];
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
