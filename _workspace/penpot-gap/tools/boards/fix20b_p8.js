const B=penpot.currentPage.root.children.find(x=>x.name.startsWith('P8 ·'));const out=[];
const w=s=>{for(const c of (s.children||[])){if(c.type==='text'){
 if(c.characters.startsWith('적용 시작일은 오늘 이후')){out.push(c.characters);c.characters='적용 시작일은 오늘+30일 이후 날짜만 골라요 · 이미 결제된 거래는 결제할 때의 수수료율 그대로예요';}
 else if(c.characters.startsWith('저장하면 대표에게 적용 30일 전에')){out.push(c.characters);c.characters='저장하면 모든 대표에게 개별 통지해요(FR-259 입점 약관 변경 통지) · 바꾼 기록이 남아요';}}w(c);}};w(B);return out;
