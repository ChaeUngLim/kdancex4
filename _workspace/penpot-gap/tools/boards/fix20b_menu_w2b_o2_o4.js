const out=[];
// W2b: 절대 좌표 사이드 메뉴 — 환불 처리 이하를 68 내리고 새 두 줄을 복제해 넣는다
{const B=FIND('W2b ·');
 const side=B.children.filter(c=>Math.round(c.x-B.x)<236&&Math.round(c.y-B.y)>=176&&Math.round(c.y-B.y)<400);
 const refundIcon=B.children.find(c=>c.type==='rectangle'&&Math.round(c.x-B.x)===28&&Math.round(c.y-B.y)===183);
 const refundTx=B.children.find(c=>c.type==='text'&&c.characters==='환불 처리'&&Math.round(c.x-B.x)<236);
 for(const c of side)c.y+=68;
 [['강사 관리',183],['학원 공지',217]].forEach(([s,y])=>{const i=refundIcon.clone();i.x=B.x+28;i.y=B.y+y;const t=refundTx.clone();t.characters=s;t.x=B.x+56;t.y=B.y+y-2;});
 out.push(['W2b',side.length]);}
// O2·O4: flex 사이드 — 예약 · 명단 뒤(3번 다음)에 복제해 끼운다
for(const pre of ['O2 ·','O4 ·']){const B=FIND(pre);const side=B.children.find(c=>c.name==='side');
 const src=side.children.find(c=>c.name==='nav:예약 · 명단');
 ['강사 관리','학원 공지'].forEach((s,k)=>{const n=src.clone();side.insertChild(4+k,n);n.name='nav:'+s;const t=n.children.find(x=>x.type==='text');t.characters=s;t.name='t:'+s;});
 out.push([pre,side.children.map(c=>c.name)]);}
return out;
