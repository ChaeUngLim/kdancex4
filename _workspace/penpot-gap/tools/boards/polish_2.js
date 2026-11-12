// 다듬기 2 — 입구 줄 추가, W6 출석 열 삭제, I9C 날짜, 옛 보드를 이전 안으로
const out=[];const roots=penpot.currentPage.root.children.filter(s=>s.type==='board');
const find=p=>roots.find(s=>s.name.startsWith(p)&&!s.name.includes('이전 안'));
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
const abs=(B,s,x,y)=>{try{if(B.flex)s.layoutChild.absolute=true;}catch(e){}s.x=B.x+x;s.y=B.y+y;return s;};
// 입구 줄
let B=find('M12 ·');if(B){abs(B,T(B,36,703,'내 정보 · 관심·취향 · 찜 목록 · 지난 주문 ›',12,'700',C.plum),36,703);out.push('M12');}
B=find('M18B ·');if(B){abs(B,T(B,36,374,'결제 수단 바꾸기 ›',12,'700',C.plum),36,374);out.push('M18B');}
B=find('I9 ·');if(B){abs(B,T(B,20,698,'강사 탈퇴 ›',12,'600',C.ink3),20,698);out.push('I9');}
B=find('I6B');if(B){abs(B,R(B,20,563,350,62,'#ffffff',{r:20,stroke:'#e8e2da',name:'card · 현장 등록'}),20,563);abs(B,T(B,36,575,'현장 등록 · 정원',14,'700'),36,575);abs(B,T(B,36,597,'현장·전화로 받은 인원을 남·여 따로 넣어요',11,'500',C.ink3),36,597);abs(B,T(B,344,581,'›',18,'600',C.ink3),344,581);out.push('I6B');}
// I9C 체험 종료일
B=find('I9C ·');if(B){const t=walk(B,[]).find(c=>(c.characters||'').includes('2026-05-03'));if(t){const s=t.characters.replace('2026-05-03','2027-05-03');const x=t.x,y=t.y,w=t.width,h=t.height,fs=t.fontSize,fw=t.fontWeight,col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||C.ink3,par=t.parent;
  const n=penpot.createText(s);par.appendChild(n);try{if(par.flex)n.layoutChild.absolute=true;}catch(e){}Object.assign(n,FONT);n.fontSize=String(fs);n.fontWeight=String(fw);n.fontVariantId=String(fw);n.growType='fixed';n.resize(w,h);n.x=x;n.y=y;n.fills=[{fillColor:col,fillOpacity:1}];n.getRange(0,s.length).fills=[{fillColor:col,fillOpacity:1}];if(par.flex)t.opacity=0;else t.remove();out.push('I9C');}else out.push('I9C 글 없음');}
// W6 출석 열
B=find('W6 ·');if(B){let n=0;for(const t of walk(B,[])){const c=t.characters||'';if(c==='출석'||/^\d+회 중 \d+회$/.test(c)){t.remove();n++;}
  else if(c.startsWith('줄을 누르면 그 회원의')){const x=Math.round(t.x-B.x),y=Math.round(t.y-B.y);t.remove();T(B,x,y,'줄을 누르면 그 회원의 수강 · 예약 이력과 문의 전체를 볼 수 있어요',12,'500',C.ink3);}}out.push('W6 출석 '+n);}
// 탭 첫 화면의 뒤로 버튼
B=find('C26A ·');if(B){const bk=[];const w2=(s)=>{for(const c of (s.children||[])){if(c.name==='back')bk.push(c);else w2(c);}};w2(B);for(const b of bk)b.remove();out.push('C26A 뒤로 '+bk.length);}
// 대체된 옛 보드를 이전 안 구역으로
for(const [p,nm] of [['O7 ·','O7 · (이전 안 · 2026-11-11 — O31 로 대체) 대표 앱 · 학원 탭'],['O1 ·','O1 · (이전 안 · 2026-11-11 — W29 로 대체) 대시보드']]){const b=find(p);if(!b)continue;let x=5320;const y=35200;
  while(roots.some(r=>r.id!==b.id&&r.x<x+b.width&&r.x+r.width>x&&r.y<y+b.height&&r.y+r.height>y))x+=1330;b.x=x;b.y=y;b.name=nm;out.push(p+' 이전 안 '+x);}
return out;
