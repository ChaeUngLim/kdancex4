// 수업 상세 판매자 고지: hero 를 36 줄이고 body 끝에 고지 글자를 넣는다 (flex 보드용)
const out=[];
for(const pre of (typeof PRES!=='undefined'?PRES:['M8 ·'])){
 const B=FIND(pre);if(!B){out.push([pre,'없음']);continue;}
 const hero=B.children.find(c=>c.name==='hero'),body=B.children.find(c=>c.name==='body');
 const shade=hero.children.find(c=>c.name==='shade');
 const DH=36;
 hero.resize(390,hero.height-DH); if(shade) shade.resize(390,shade.height-DH);
 const refund=body.children[body.children.length-1];
 const src=(refund.children||[]).find(k=>k.type==='text');
 const t=src.clone(); body.appendChild(t);
 const s='K-DanceX4는 통신판매중개자이며 판매 당사자가 아니에요. 이 수업은 라틴하우스 강남이 판매해요 · 판매자 정보 ›';
 t.name='t:통신판매중개 고지'; t.characters=s; t.fontSize='11'; t.fills=[{fillColor:C.ink3,fillOpacity:1}];
 t.resize(350,34);
 out.push([pre,t.parent&&t.parent.name,Math.round(t.y-B.y),Math.round(t.width),Math.round(body.height)]);
}
return out;
