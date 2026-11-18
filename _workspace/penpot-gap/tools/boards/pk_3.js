// 기존 OTP 화면(W1b2): 패스키로 돌아가는 길을 더한다. 맨 위 설명 글은 지우고 새로 쓴다(글 내용 바꾸기는 반영되지 않음)
const B=FIND('W1b2 ·');
B.children.filter(s=>s.type==='text' && /^관리자 웹은 비밀번호 다음에 인증 앱/.test(s.characters)).forEach(s=>s.remove());
T(B,760,236,'패스키를 쓸 수 없을 때 인증 앱 코드로 확인해요',14,'500',C.ink3,{w:390});
T(B,760,646,'‹ 지문·얼굴로 인증하기',12,'700',C.plum);
return B.id;
