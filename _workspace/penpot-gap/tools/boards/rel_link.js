const P=penpot.currentPage.root.children;const bd=n=>P.find(x=>x.name.startsWith(n));
const W3b=bd('W3b ·'),W3b2=bd('W3b2 ·'),W3a=bd('W3a ·'),I28=bd('I28 ·'),I28B=bd('I28B ·'),I12=bd('I12 ·');
const go=(s,to,l)=>{if(!s)return l+': 못 찾음';(s.interactions||[]).slice().forEach(i=>s.removeInteraction(i));s.addInteraction('click',{type:'navigate-to',destination:to});return l+' → '+to.name.slice(0,6);};
const pos=(b,x,y,t)=>b.children.find(s=>s.type===t&&Math.round(s.x-b.x)===x&&Math.round(s.y-b.y)===y);
const nm=(b,n)=>b.children.find(s=>s.name===n);
const txt=(b,re)=>b.children.filter(s=>s.type==='text'&&re.test(s.characters));
const out=[go(pos(W3b,1040,672,'rectangle'),W3b2,'W3b 소속 해제'),go(nm(W3b2,'btn:돌아가기'),W3b,'W3b2 돌아가기'),go(nm(W3b2,'btn:알림 보내고 해제'),W3a,'W3b2 보내고 해제'),
 go(nm(I28,'btn:off'),I28B,'I28 해제 버튼'),go(nm(I28B,'btn:돌아가기'),I28,'I28B 돌아가기'),go(nm(I28B,'btn:알림 보내고 해제'),I12,'I28B 보내고 해제')];
txt(W3b,/명단 보기/).forEach((s,i)=>out.push(go(s,W3b2,'W3b 명단 보기'+i)));
txt(I28,/^명단 보기/).forEach(s=>out.push(go(s,I28B,'I28 명단 보기')));
return out;
