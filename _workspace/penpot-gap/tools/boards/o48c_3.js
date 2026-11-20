// 하단 탭 「학원」 강조 + 클릭 연결. O48 의 글자는 바꾸지 않는다.
const roots=penpot.currentPage.root.children.filter(s=>s.type==='board'&&!s.name.includes('이전 안'));
const out=[];
const B=roots.find(s=>s.name.startsWith('O48C ·'));
const tabOf=b=>(b.children||[]).find(c=>c.name&&c.name.startsWith('tabbar'));
const onOf=tb=>{const t=(tb.children||[]).filter(c=>c.type==='text').find(t=>String(t.fontWeight)>='700');return t?t.characters:null;};
const old=tabOf(B);
if(onOf(old)!=='학원'){const src=roots.map(tabOf).find(tb=>tb&&tb.name.includes('대표')&&onOf(tb)==='학원');
 if(src){const x=old.x,y=old.y;const c=src.clone();B.appendChild(c);c.x=x;c.y=y;old.remove();out.push('탭→학원');}else out.push('학원 탭 원본 없음');}
const bd=n=>roots.find(s=>s.name.startsWith(n+' ·'));
const all=b=>{const a=[];const w=s=>{for(const c of (s.children||[])){a.push(c);w(c);}};w(b);return a;};
const link=(s,to,l)=>{if(!s||!bd(to)){out.push(l+': 없음');return;}(s.interactions||[]).slice().forEach(i=>s.removeInteraction(i));s.addInteraction('click',{type:'navigate-to',destination:bd(to)});out.push(l+'→'+to);};
// O48C → O22: 「송금 완료」(O48B 확인과 같은 도착지) · 「이름이 달라요」도 O22
link(all(B).find(s=>s.name==='btn:송금 완료 (체크해야 켜져요)'),'O22','O48C 송금 완료');
link(all(B).find(s=>s.name==='btn:이름이 달라요 · 다시 입력 요청'),'O22','O48C 다시 입력 요청');
// O48 → O48C: O48 은 카드 예시라 글을 바꾸지 않고, 계좌 결제분 안내 줄 위에 투명 연결 영역(link:O48C)만 얹는다
const o=bd('O48');
if(o){const t=all(o).find(s=>s.type==='text'&&/^신용카드 결제는 카드 결제 취소로/.test(s.characters));
 if(t){let h=all(o).find(s=>s.name==='link:O48C');if(!h){h=penpot.createRectangle();o.appendChild(h);h.name='link:O48C';h.x=t.x;h.y=t.y;h.resize(350,34);h.fills=[];}link(h,'O48C','O48 계좌 결제분');}else out.push('O48 안내 줄 없음');}
return out;
