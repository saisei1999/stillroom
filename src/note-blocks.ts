export type BlockKind = 'text' | 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'numbered' | 'quote' | 'todo' | 'done';
export type Block = { kind: BlockKind; text: string; prefix?: string };
export function parseLine(line: string): Block {
  const patterns: [RegExp, BlockKind][] = [[/^### /,'heading3'],[/^## /,'heading2'],[/^# /,'heading1'],[/^- \[x\] /i,'done'],[/^- \[ \] /,'todo'],[/^[-*] /,'bullet'],[/^\d+\. /,'numbered'],[/^> /,'quote']];
  for (const [pattern,kind] of patterns) if (pattern.test(line)) { const match=line.match(pattern); return {kind,text:line.replace(pattern,''),prefix:match?.[0]}; }
  return {kind:'text',text:line};
}
export function serializeLine(block: Block): string {
  const prefix: Record<BlockKind,string> = { text:'',heading1:'# ',heading2:'## ',heading3:'### ',bullet:'- ',numbered:'1. ',quote:'> ',todo:'- [ ] ',done:'- [x] ' };
  return (block.prefix ?? prefix[block.kind])+block.text;
}
export function moveBlock<T>(items:T[],from:number,to:number):T[]{if(from<0||to<0||from>=items.length||to>=items.length)return items;const next=[...items];const [item]=next.splice(from,1);next.splice(to,0,item);return next}
