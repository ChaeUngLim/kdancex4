const B=FIND('I28B ·');
const r=n=>B.children.find(s=>s.name==='chip:'+n);
const t=(x)=>B.children.find(s=>s.type==='text'&&Math.round(s.x-B.x)===x&&Math.round(s.y-B.y)===279);
const a=r('대체 강사'),h=r('휴강'),off=r('폐강');
const onF=a.fills,onS=a.strokes,offF=off.fills,offS=off.strokes;
h.fills=onF;h.strokes=onS;a.fills=offF;a.strokes=offS;
const ta=t(36),th=t(122),tf=t(178);const onT=ta.fills,offT=tf.fills;th.fills=onT;ta.fills=offT;
return 'ok';
