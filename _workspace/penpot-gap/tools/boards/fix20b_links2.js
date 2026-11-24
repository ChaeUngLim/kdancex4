const P=penpot.currentPage.root.children.filter(x=>x.type==='board'&&!/이전 안|폐기/.test(x.name));
const bd=n=>P.find(x=>x.name.startsWith(n+' ·'));const out=[];
{const B=bd('W27'),D=bd('W31');const src=B.children.find(c=>c.type==='text'&&c.characters.startsWith('이벤트형 취소는 이 목록이'));
 const t=src.clone();t.characters='계좌 결제분 환불은 대표님 은행에서 송금해요 · 계좌 환불 송금 ›';t.name='link:W31';t.y=src.y+36;
 t.fills=[{fillColor:C.plum,fillOpacity:1}];t.addInteraction('click',{type:'navigate-to',destination:D});out.push(['W27',Math.round(t.x-B.x),Math.round(t.y-B.y),Math.round(t.width)]);}
{const B=bd('W1c'),D=bd('P1');const t=B.children.find(c=>c.type==='text'&&c.characters==='플랫폼 정산');t.addInteraction('click',{type:'navigate-to',destination:D});out.push('W1c→P1');}
return out;
