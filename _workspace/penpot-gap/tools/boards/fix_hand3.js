// 그림 검토 뒤 고침 — 스크립트 없는 W4a·W4b·O21B: 연락처 자리 표시, 끝 글자만 넘어가는 줄을 단어 단위로 나눔
const out=[];
const RE=(pre,start,fn)=>{const B=FIND(pre);if(!B){out.push([pre,'없음']);return;}let n=0;
  for(const t of [...B.children]){if(t.type!=='text')continue;const c=t.characters||'';if(!c.startsWith(start))continue;
    const x=Math.round(t.x-B.x),y=Math.round(t.y-B.y),w=Math.round(t.width);const fs=+t.fontSize,fw=String(t.fontWeight);const col=(t.fills&&t.fills[0]&&t.fills[0].fillColor)||C.ink;
    const s=fn(c);t.remove();T(B,x,y,s,fs,fw,col,{w:Math.max(w,tw(s.split('\n')[0],fs)+6)});n++;}
  out.push([pre,start.slice(0,10),n]);};
const br=(...anchors)=>c=>{let s=c;for(const a of anchors){s=s.replace(' '+a,'\n'+a);}return s;};
RE('W4a ·','02-555-0142',()=>'00-000-0000');
RE('W4b ·','02-555-0142',()=>'00-000-0000');
RE('W4a ·','이미 결제한 수강생에게는',br('그대로 적용돼요','등록·결제분부터'));
RE('W4b ·','결제한 회원이 있으면',br('늦추는 것만'));
RE('W4b ·','정원이 차면 결제가',br('취소표는'));
RE('W4b ·','예매 수수료 2,000원은',br('취소해도','법정 청약철회'));
RE('W4b ·','휴강·폐강이나 행사',br('전액 돌려줘요'));
RE('O21B ·','11/18 쌈바(입문) · 김하나',br('대타를'));
RE('O21B ·','이준호 강사 요청',br('수강생 10명'));
RE('O21B ·','바차타 센슈얼 입문 · 카드',c=>'바차타 센슈얼 입문 · 카드\n남은 자리 남 2 · 여 1');
return out;
