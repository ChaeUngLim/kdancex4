const B=FIND('O21 ·');const scr=B.children.find(c=>c.name==='screen');
const row=scr.children.find(c=>c.name.includes('종류 칩'));
const src=row.children.find(c=>c.name==='chip:정산');
const n=src.clone();row.appendChild(n);n.name='chip:운영';
const t=n.children.find(k=>k.type==='text');t.characters='운영';
return [Math.round(n.x-B.x),Math.round(n.width),t.characters,row.children.map(c=>c.name)];
