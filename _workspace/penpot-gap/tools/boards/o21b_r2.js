const B=FIND('O21B ·');
let y=Number(B.getPluginData('y'));
y+=ITEM2(B,y,'info','취소','12월 라틴 파티 · 오늘 취소 5건','평소보다 취소가 많아요 · 남은 자리 12','신청 현황 ›','08:30',false);
y+=ITEM2(B,y,'info','신청','살사 온투 기초 · 1시간 동안 신청 8건','남은 자리 남 1 · 여 0',null,'어제',false);
y+=ITEM2(B,y,'warn','충돌','11/14 (토) 19:00 B실이 겹쳐요','룸바 중급과 대관 일정이 같은 시간이에요\n강의실 배정은 관리자 웹에서 고쳐요',null,'어제',false);
y+=ITEM2(B,y,'sel','강사','김하나 강사 · 11/18 룸바 중급 휴강','강사가 이 회차를 휴강으로 처리했어요\n수강생 6명에게 알림이 갔어요','수업 보기 ›','어제',false);
const H=y+24+84;B.resize(390,H);
const tb=B.children.find(c=>(c.name||'').startsWith('tabbar'));if(tb){tb.x=B.x;tb.y=B.y+H-84;}
B.setPluginData('y',String(y));
return [y,H,!!tb];
