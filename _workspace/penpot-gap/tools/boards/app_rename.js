const P=penpot.currentPage.root.children.filter(x=>x.type==='board'&&!/이전 안/.test(x.name));const out=[];
const rn=(p,a,b)=>{const x=P.find(s=>s.name.startsWith(p+' ·'));if(!x||!x.name.includes(a)){out.push(p+' 못 바꿈');return;}x.name=x.name.replace(a,b);out.push(x.name.slice(0,70));};
rn('O22','환불 금액·실행은 관리자 웹','환불 금액·실행도 앱(O48 · 실행 전 패스키)');
rn('O24','등록·수정은 관리자 웹','등록은 관리자 웹 · 정원·휴강은 O43');
rn('O26','승인은 관리자 웹에서만 — 돈을 보내는 일','승인은 정식 운영부터 앱 O49(패스키) · 베타는 관리자 웹');
rn('O31','관리자 웹 권한은 웹에서','관리자 웹 위임 권한·소속 관리는 O37·O38');
rn('O33','관리자 웹 권한은 웹에서','관리자 웹 위임 권한은 O38');
return out;
