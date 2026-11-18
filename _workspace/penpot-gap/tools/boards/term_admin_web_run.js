
const ITEMS=[["W1b", "035f20", [["관리 웹", "관리자 웹"]]], ["W3a", "f8e6a7", [["관리 웹", "관리자 웹"]]], ["W1c", "8a595f", [["관리 웹", "관리자 웹"]]], ["O23", "857af8", [["관리 웹", "관리자 웹"]]], ["O27", "1d1fcd", [["관리 웹", "관리자 웹"]]], ["O33", "0b15c5", [["관리 웹", "관리자 웹"]]], ["O31", "ec45b9", [["관리 웹", "관리자 웹"]]], ["O38", "7b5a7b", [["관리 웹", "관리자 웹"]]], ["O38", "39469c", [["관리 웹", "관리자 웹"]]], ["O38", "8b1915", [["관리 웹", "관리자 웹"]]], ["O38", "43ff60", [["관리 웹", "관리자 웹"]]], ["O38", "b787b0", [["관리 웹", "관리자 웹"]]], ["O40", "dffdf9", [["관리 웹", "관리자 웹"]]], ["O43", "ff1f75", [["관리 웹", "관리자 웹"]]], ["O47", "c3b6bc", [["관리 웹", "관리자 웹"]]], ["O47", "c5f766", [["관리 웹", "관리자 웹"]]], ["O49", "46f16d", [["관리 웹", "관리자 웹"]]]];const out=[];
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
for(const b of penpot.currentPage.root.children){if(b.type==='board'&&b.name.includes('관리 웹')&&!b.name.includes('이전 안')&&!b.name.includes('폐기')){b.name=b.name.split('관리 웹').join('관리자 웹');out.push(['이름',b.name.slice(0,14)]);}}
return out;
