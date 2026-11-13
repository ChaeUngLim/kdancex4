const P=penpot.currentPage.root.children;const out=[];
P.filter(x=>x.type==='board'&&/^OA[1-4] ·/.test(x.name)&&!/이전 안/.test(x.name)).forEach(b=>{b.name=b.name.replace(/^(OA[1-4]) · /,'$1 · (이전 안 · 2026-11-13 — 대표 앱 확대 O6·O23~O49 로 대체) ');out.push(b.name.slice(0,60));});
const lab=penpot.currentPage.getShapeById('4e306f61-c505-80dd-8008-c5894a5c6e69');
if(lab&&lab.type==='text'&&lab.name==='라벨: O7'){out.push('지움: '+lab.name+' @'+lab.x+','+lab.y);lab.remove();}else out.push('라벨 못 찾음');
return out;
