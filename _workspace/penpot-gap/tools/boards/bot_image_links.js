const P=penpot.currentPage.root.children.filter(x=>x.type==='board'&&!/이전 안/.test(x.name));const bd=n=>P.find(x=>x.name.startsWith(n+' ·'));
const all=(b)=>{const a=[];const w=s=>{for(const c of (s.children||[])){a.push(c);w(c);}};w(b);return a;};
const go=(s,to,l)=>{if(!s)return l+': 없음';(s.interactions||[]).slice().forEach(i=>s.removeInteraction(i));s.addInteraction('click',{type:'navigate-to',destination:bd(to)});return l+'→'+to;};
const byName=(b,re)=>all(bd(b)).filter(s=>re.test(s.name||''));
const byText=(b,re)=>all(bd(b)).filter(s=>s.type==='text'&&re.test(s.characters));
const btn=(b,label)=>{const r=byName(b,new RegExp('^btn:'+label));return r.length?r:byText(b,new RegExp('^'+label));};
const out=[];const L=(arr,to,l)=>{if(!arr.length)out.push(l+': 없음');arr.forEach(s=>out.push(go(s,to,l)));};
// 2026-11-13 강사 수업 찾기(FR-037a)와 수업 이미지 프롬프트(FR-061a) 보드의 클릭 연결
L(btn('M15','AI 플래너에게'),'M10F','M15 입구');L(btn('M10F','신청하기'),'M8','M10F 신청');L(btn('M10G','선택'),'M10F','M10G 선택');
L(btn('I32B','AI 이미지 만들기'),'I32','I32B 만들기');L(byText('I32B',/^예시 보기/),'I32C','I32B 예시');L(btn('I32C','이 예시로 시작'),'I32B','I32C 시작');
L(byText('I32',/^고치기 ›/),'I32D','I32 고치기');L(btn('I32D','이 문구로 저장'),'I32','I32D 저장');
return out;