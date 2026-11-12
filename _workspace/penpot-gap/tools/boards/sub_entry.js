// 1) I6B 수업 관리 탭에 「대타 요청」 입구 — flex 보드라 절대 위치로 얹는다
const I=FIND('I6B');
const fix=(s,x,y)=>{try{s.layoutChild.absolute=true;}catch(e){}s.x=I.x+x;s.y=I.y+y;return s;};
fix(R(I,20,489,350,62,'#ffffff',{r:20,stroke:'#e8e2da',name:'card · 대타 요청'}),20,489);
fix(T(I,36,501,'대타 요청',14,'700'),36,501);
fix(T(I,36,523,'이 회차를 대신 맡을 강사를 찾아요',11,'500',C.ink3),36,523);
fix(T(I,344,507,'›',18,'600',C.ink3),344,507);
// 2) 대표 알림함 O21B 맨 위에 「대타 확인」 알림 — 아래 줄을 밀고 넣는다
const B=FIND('O21B ·');const H=112;
for(const s of [...B.children]){if(Math.round(s.y-B.y)>=166)s.y=s.y+H;}
B.resize(390,Math.round(B.height)+H);
const h=ITEM(B,166,'sel','대타','11/18 쌈바(입문) · 김하나 강사가 대타를 수락했어요','이준호 강사 요청 · 확인하면 수강생 10명에게 알림이 가요','확인하기 ›','11:05',true);
return [h,B.height];
