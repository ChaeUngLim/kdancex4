// 사용: 앞에 `const NAME='W8 ·';` 를 붙여 실행. PNG 를 base64 로 돌려준다.
const bytes=await FIND(NAME).export({type:'png',scale:1});
let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);
return btoa(s);
