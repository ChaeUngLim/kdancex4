// 강사 마이 · 멤버십 이용 중 — 해지하기 입구 (FR-112e)
const B=PAGE('I9F · 강사 마이 · 멤버십 이용 중 (연 멤버십 · 기간·다음 결제일 · 해지하기 › 로 I37B)',5280,'멤버십');
CARD(B,20,88,350,150,{r:16});
CHIP(B,36,104,'이용 중',C.plumL,C.plum,11);
T(B,36,136,'연 멤버십',18,'800');
T(B,36,164,'2027-05-03 – 2028-05-02 · 108,000원 결제',12,'500',C.ink2);
T(B,36,188,'다음 결제 2028-05-03 (수) · 신용카드 국민 ****1234',11,'500',C.ink3);
T(B,36,210,'인원 표·명단·레벨·캘린더·AI 를 쓰는 선택 기능이에요.',11,'500',C.ink3);
R(B,20,254,350,52,'#ffffff',{r:14,stroke:C.line,name:'row · 해지하기'});
T(B,36,270,'해지하기',14,'700',C.ink);T(B,340,270,'›',15,'600',C.ink3);
T(B,20,322,'해지하면 다음 갱신만 멈추고, 낸 기간은 끝까지 써요. 환불은 없어요.',11,'500',C.ink3,{w:350});
const root=penpot.currentPage.root.children;const f=root.find(s=>s.type==='board'&&s.name.startsWith('I37B ·'));
const rr=B.children.find(c=>c.name==='row · 해지하기');if(rr&&f)rr.addInteraction('click',{type:'navigate-to',destination:f});
B.setPluginData('ok','1');
return B.id;
