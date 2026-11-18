// 관리자 웹 로그인 흐름 클릭 연결: W1a → W1b(패스키) → W1c(콘솔), 대체 W1b2(OTP), 첫 등록 W1b3
const P=penpot.currentPage.root.children;
const bd=n=>P.find(x=>x.name.startsWith(n));
const A=bd('W1a ·'),PK=bd('W1b ·'),OTP=bd('W1b2 ·'),REG=bd('W1b3 ·'),CON=bd('W1c ·');
const rect=(b,x,y)=>b.children.find(s=>s.type==='rectangle'&&Math.round(s.x-b.x)===x&&Math.round(s.y-b.y)===y);
const txt=(b,re)=>b.children.find(s=>s.type==='text'&&re.test(s.characters));
const go=(s,to,label)=>{ if(!s) return label+': 못 찾음'; s.addInteraction('click',{type:'navigate-to',destination:to}); return label+' → '+to.name.slice(0,10); };
return [
  go(rect(A,760,462),PK,'W1a 로그인 버튼'),
  go(txt(A,/^로그인$/)&&A.children.filter(s=>s.type==='text'&&s.characters==='로그인').sort((a,b)=>b.y-a.y)[0],PK,'W1a 로그인 글자'),
  go(rect(PK,760,472),CON,'W1b 지문·얼굴로 인증'),
  go(txt(PK,/^인증 앱 코드로/),OTP,'W1b 인증 앱 코드로'),
  go(rect(REG,760,472),CON,'W1b3 패스키 만들기'),
  go(txt(REG,/^인증 앱으로/),OTP,'W1b3 인증 앱으로'),
  go(rect(OTP,760,472),CON,'W1b2 확인'),
  go(txt(OTP,/^‹ 지문·얼굴로/),PK,'W1b2 지문·얼굴로 돌아가기'),
];
