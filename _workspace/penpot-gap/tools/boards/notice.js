const out=[];
for(const pre of ['M9 · 결제','M9N ·','L4 ·','M9E ·']){
 const B=FIND(pre); if(!B){out.push([pre,'없음']);continue;}
 let cy=null; const walk=s=>{for(const c of (s.children||[])){if(c.type==='text'&&(c.characters||'').startsWith('환불 규칙과 개인정보'))cy=Math.round(c.y-B.y);else walk(c);}}; walk(B);
 const seller=pre==='M9E ·'?'라틴하우스 강남':'라틴하우스 강남';
 const s='K-DanceX4는 통신판매중개자이며 판매 당사자가 아니에요. 이 수업은 '+seller+'이 판매해요 · 판매자 정보 ›';
 const t=penpot.createText(s);B.appendChild(t);t.name='t:통신판매중개 고지';
 if(B.flex){try{t.layoutChild.absolute=true;}catch(e){out.push([pre,'abs fail '+e]);}}
 Object.assign(t,FONT);t.fontSize='11';t.fontWeight='500';t.fontVariantId='500';t.growType='fixed';t.lineHeight='1.5';
 t.resize(350,34);t.x=B.x+20;t.y=B.y+cy+28;
 t.fills=[{fillColor:C.ink3,fillOpacity:1}];t.getRange(0,s.length).fills=[{fillColor:C.ink3,fillOpacity:1}];
 out.push([pre,cy,Math.round(t.x-B.x),Math.round(t.y-B.y)]);
}
return out;
