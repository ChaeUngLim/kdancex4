const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
const find=p=>roots.find(s=>s.name.startsWith(p)&&!s.name.includes('이전 안'));
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
const out={};
for(const p of ['M12 ·','M18B ·','I9 ·','I9C ·']){const B=find(p);if(!B){out[p]='없음';continue;}
 const ts=walk(B,[]).map(t=>[Math.round(t.x-B.x),Math.round(t.y-B.y),(t.characters||'').replace(/\n/g,' ').slice(0,26)]).filter(t=>t[1]>80&&t[1]<B.height-90).sort((a,b)=>a[1]-b[1]);
 out[p]={h:Math.round(B.height),flex:!!B.flex,x:Math.round(B.x),y:Math.round(B.y),tail:ts.slice(-9)};}
const W=find('W6 ·');out.W6=walk(W,[]).filter(t=>/출석|회 중/.test(t.characters||'')).map(t=>[t.id.slice(-6),Math.round(t.x-W.x),Math.round(t.y-W.y),t.characters.slice(0,20)]);
out.old=['O7 ·','O1 ·'].map(p=>{const b=find(p);return b?[b.name.slice(0,30),Math.round(b.x),Math.round(b.y),b.width,Math.round(b.height)]:p+' 없음';});
return out;
