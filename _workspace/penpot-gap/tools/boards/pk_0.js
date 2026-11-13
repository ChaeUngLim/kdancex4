// 기존 W1b 를 복제해 왼쪽 패널만 남긴 틀 두 장을 만든다(패스키 기본·패스키 등록)
const P=penpot.currentPage.root.children;
const src=P.find(x=>x.name.startsWith('W1b ·'));
const mk=(name,x,y)=>{const c=src.clone();c.name=name;c.x=x;c.y=y;
  c.children.filter(s=>(s.x-c.x)>=740 && s.type!=='frame').forEach(s=>{ if(!((s.x-c.x)===720 && s.name==='card')) s.remove(); });
  return c.id;};
const a=mk('W1b · 2단계 인증 (패스키 기본 · 지문·얼굴·화면 잠금 · 대표·운영자 공통)',6650,23700);
const b=mk('W1b3 · 패스키 등록 (첫 로그인 한 번 · 기기마다 · 못 쓰면 인증 앱으로)',7980,23700);
src.name='W1b2 · 2단계 인증 대체 수단 (인증 앱 OTP · 패스키를 못 쓸 때만 · 대표·운영자 공통)';
return {a,b,left:penpot.currentPage.getShapeById(a).children.length};
