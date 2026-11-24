const out=[];
for(const pre of ['O2 ·','O4 ·']){const B=FIND(pre);const side=B.children.find(c=>c.name==='side');
 const r=side.children.find(c=>c.name==='nav:예약 · 명단');r.setParentIndex(8);
 out.push(side.children.map(c=>c.name).join('|'));}
return out;
