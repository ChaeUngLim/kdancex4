const out=[];
const getB=p=>penpot.currentPage.root.children.find(x=>x.name.startsWith(p));
const byId=(B,id)=>{let r=null;const w=s=>{for(const c of (s.children||[])){if(c.id.endsWith(id))r=c;w(c);}};w(B);return r;};
const setT=(B,id,exp,to)=>{const t=byId(B,id);if(!t||t.type!=='text'){out.push([id,'없음']);return null;}if(exp&&!t.characters.startsWith(exp)){out.push([id,'불일치',t.characters.slice(0,20)]);return null;}t.characters=to;return t;};
const note=(B,srcId,s,x,y,w)=>{const src=byId(B,srcId);const t=src.clone();t.characters=s;t.name='t:예매 수수료 제외';t.resize(w,t.height);t.x=B.x+x;t.y=B.y+y;return t;};
// W31
{const B=getB('W31 ·');
 setT(B,'7b721','합계','합계 236,200원');
 [['466a3',222],['3f9e8',310],['13287',398]].forEach(([id,y])=>{setT(B,id,'45,000','43,000원');note(B,'b8036','예매 수수료 2,000원 제외',740,y,170);});
 setT(B,'3dfd6','45,000','43,000원');note(B,'4539c','결제 45,000원 − 예매 수수료 2,000원',970,450,250);out.push('W31');}
// O48C
{const B=getB('O48C ·');setT(B,'8e47b','45,000','43,000원');
 let src=null;const w=s=>{for(const c of (s.children||[])){if(c.type==='text'&&c.characters.startsWith('간편 계좌이체로 결제'))src=c;w(c);}};w(B);
 const t=src.clone();t.characters='결제 45,000원 − 예매 수수료 2,000원 제외';t.name='t:예매 수수료 제외';t.resize(300,t.height);t.x=B.x+36;t.y=B.y+290;out.push(['O48C',!!src]);}
// W27B
{const B=getB('W27B ·');
 ['873d6','c674b'].forEach(id=>setT(B,id,'35,000','33,000'));setT(B,'df2fd','35,000','33,000원');
 note(B,'5526e','예매 수수료 2,000원 제외',770,312,140);note(B,'fcc76','예매 수수료 2,000원 제외',770,388,140);
 note(B,'428bd','예매 수수료 2,000원 제외',1020,416,208);out.push('W27B');}
// W18
{const B=getB('W18 ·');
 setT(B,'72eed','12/19','12/19 (토) 19:00 · B홀 · 결제한 32명 전원에게 참가비를 환불하고 행사를 닫아요 · 회원에게 고르게 하지 않아요');
 setT(B,'26859','예매 수수료','예매 수수료 2,000원은 플랫폼 몫이라 사유와 관계없이 돌려주지 않아요. 참가비만 돌려줘요.');
 setT(B,'00db2','64,000','64,000원 · 환불하지 않아요');
 setT(B,'2ea38','돌려주는','돌려주는 돈 · 참가비');
 setT(B,'fd2fd','1,184,000','1,120,000원');
 setT(B,'2c2ac','· 환불 마감일','· 환불 마감일(12/16)이 지났어도 참가비는 전부 돌려줘요');
 setT(B,'207e5','32명','32명에게 환불하고 행사 취소');out.push('W18');}
return out;
