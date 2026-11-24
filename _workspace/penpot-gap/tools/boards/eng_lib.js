// 생성 엔진 카드 — FR-061a(홍보 이미지 생성 조건) 「생성 엔진은 사용자가 고른다」(2026-11-23)
// 카드마다 이름 · 「빠름/보통/화질 우선」 한 마디와 예상 시간 · 지금 쓸 수 있는지를 보인다.
// st: 'on'(고름) · 'ok'(쓸 수 있음) · 'off'(엔진 전체 하루 한도가 차서 잠김)
const ENGINES=[
  ['FLUX.1 schnell','빠름 · 약 5초','지난번에 고른 엔진','on'],
  ['Sana Sprint','빠름 · 약 10초','쓸 수 있어요','ok'],
  ['FLUX.2 klein','보통 · 약 30초','쓸 수 있어요','ok'],
  ['Z-Image Turbo','화질 우선 · 약 40초','오늘은 더 쓸 수 없어요','off'],
];
function ENG(B,x,y,w,h,[name,desc,status,st]){
  const fill=st==='on'?C.sel:(st==='off'?C.input:C.card);
  R(B,x,y,w,h,fill,{r:12,stroke:st==='on'?C.selLine:C.line,sw:st==='on'?2:1,name:'engine:'+name});
  T(B,x+12,y+10,name,12,'700',st==='off'?C.ink3:C.ink);
  T(B,x+12,y+28,desc,11,'500',st==='off'?C.ink3:C.ink2);
  T(B,x+12,y+45,status,11,'600',st==='off'?C.warn:(st==='on'?C.plum:C.ink3));
}
