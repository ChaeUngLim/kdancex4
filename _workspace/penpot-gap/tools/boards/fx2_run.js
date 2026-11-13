
const ITEMS=[["O25", "8af443", [[".*", "정산 명세 내려받기 · 정산 계좌 변경 · 강의실 주간표 · 환불·취소 공지 양식 · 행사 등록과 일괄 취소 · 입점 해지. PC 에서 같은 아이디로 로그인하고 2단계 인증을 거쳐요."]]], ["O31", "1b5663", [[".*", "소속 신청·초대·해제와 관리 웹 위임 권한은 강사 관리에서 바꿔요 ›"]]], ["O33", "fe4223", [[".*", "관리 웹 위임 권한도 앱에서 켜고 꺼요 ›"]]], ["O29", "98b11a", [[".*", "결산 표 · 공제 상세 · 내려받기 · 계좌 변경은 관리자 웹에서 해요."]]], ["O6", "267355", [[".*", "오늘 현장 등록 › — 현장·전화로 받은 인원을 바로 넣어요. 계좌 변경·명세 내려받기는 관리자 웹에서 해요."]]], ["O24", "154a50", [[".*", "정원·휴강은 수업을 눌러 바꿔요 ›"]]], ["O22", "0c0792", [[".*", "답하기 ›   환불 처리 ›"]]], ["O22", "636588", [[".*", "답변도, 환불 금액 정하기와 실행도 앱에서 해요. 실행 직전에 지문으로 한 번 더 확인해요(학원 환불 규정 기준)."]]], ["O26", "b08d6e", [[".*", "정식 운영부터 앱에서 승인해요 ›"]]], ["O26", "d4d08b", [[".*", "돈을 보내는 일이라 승인 직전에 지문으로 한 번 더 확인해요. 베타 동안은 관리자 웹에서 지급 파일을 내려받아 보내요."]]]];const out=[];
const walk=(s,acc)=>{for(const c of (s.children||[])){if(c.type==='text')acc.push(c);else walk(c,acc);}return acc;};
for(const [bn,suf,reps] of ITEMS){
  const B=penpot.currentPage.root.children.find(s=>s.type==='board'&&s.name.startsWith(bn+' ·')&&!s.name.includes('이전 안'));
  const t=B&&walk(B,[]).find(c=>c.id.endsWith(suf));
  if(!t){out.push([bn,suf,'없음']);continue;}
  let nv=t.characters; for(const [re,r] of reps){ nv = re==='.*'? r : nv.replace(new RegExp(re),r); }
  const x=t.x,y=t.y,w=t.width,h=t.height,fs=t.fontSize,fw=t.fontWeight,al=t.align,lh=t.lineHeight;
  const col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||'#141216';const parent=t.parent;
  const n=penpot.createText(nv);parent.appendChild(n);n.name='t:'+nv.slice(0,12);
  Object.assign(n,FONT);n.fontSize=String(fs);n.fontWeight=String(fw);n.fontVariantId=String(fw);n.growType='fixed';if(lh)n.lineHeight=String(lh);if(al)n.align=al;
  const longest=Math.max(...nv.split('\n').map(l=>tw(l,Number(fs))));const nl=nv.split('\n').length;
  const lines=Math.max(nl,Math.ceil(longest/Math.max(w,40)));
  const nw=(al==='center'||al==='right')?w:Math.max(w,lines>nl?w:longest);
  n.resize(nw,Math.max(h,Math.ceil(Number(fs)*1.5*lines)));n.x=x;n.y=y;
  n.fills=[{fillColor:col,fillOpacity:1}];n.getRange(0,nv.length).fills=[{fillColor:col,fillOpacity:1}];
  t.remove(); out.push([bn,nv.slice(0,30)]);
}
return out;
