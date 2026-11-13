const P=penpot.currentPage.root.children;
const A=P.find(x=>x.name.startsWith('W1a ·')),REG=P.find(x=>x.name.startsWith('W1b3 ·'));
const t=A.children.find(s=>s.type==='text'&&/^입점 신청이 승인되면/.test(s.characters));
t.addInteraction('click',{type:'navigate-to',destination:REG});
return t.interactions.map(i=>i.action.destination.name.slice(0,12));
