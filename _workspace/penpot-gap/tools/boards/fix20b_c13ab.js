const out=[];
const mk=(B,y)=>{const s='K-DanceX4는 통신판매중개자이며 판매 당사자가 아니에요. 이 수업은 라틴하우스 강남이 판매해요 · 판매자 정보 ›';
 const t=penpot.createText(s);B.appendChild(t);t.name='t:통신판매중개 고지';
 Object.assign(t,FONT);t.fontSize='11';t.fontWeight='500';t.fontVariantId='500';t.growType='fixed';t.lineHeight='1.3';
 t.resize(350,29);t.x=B.x+20;t.y=B.y+y;t.fills=[{fillColor:C.ink3,fillOpacity:1}];t.getRange(0,s.length).fills=[{fillColor:C.ink3,fillOpacity:1}];return t;};
// C13A: 환불 규칙 제목·본문을 10 올리고 그 아래에 고지
{const B=FIND('C13A ·');
 for(const c of B.children){if(c.type==='text'){const y=Math.round(c.y-B.y);if(y===714||y===734)c.y-=10;}}
 mk(B,742);out.push('C13A');}
// C13B: 402 이후 12 올리고, 알림 카드 10 줄이고, 안내 글 10 더 올린 뒤 고지
{const B=FIND('C13B ·');
 for(const c of B.children){const y=Math.round(c.y-B.y);if(c.name.startsWith('tabbar')||c.name.startsWith('btn:')||y<402||y>=778)continue;
  if(c.type==='text'&&y===794)continue; c.y-=12;}
 for(const c of B.children){const y=Math.round(c.y-B.y);if(c.type==='rectangle'&&c.name==='card'&&y===604)c.resize(350,108);if(c.type==='text'&&y===732)c.y-=10;}
 mk(B,744);out.push('C13B');}
return out;
