import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
test('brand text flex item may shrink and full tagline wraps instead of clipping outside mobile RTL sidebar',()=>{
 const word=css.match(/\.brand-word\{([^}]+)\}/)?.[1]??'',tag=css.match(/\.brand-word small\{([^}]+)\}/)?.[1]??'';
 assert.match(word,/min-width:0/);assert.match(word,/flex:1/);assert.match(tag,/white-space:normal/);assert.doesNotMatch(tag,/text-overflow:ellipsis|white-space:nowrap|overflow:hidden/);
});
