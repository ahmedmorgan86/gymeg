import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageNotificationBody,unseenIncomingMessages} from '../app/lib/message-notifications.ts';
import {readFileSync} from 'node:fs';

const messages=[
 {id:'m1',side:'member',branch:'north',text:'Need help'},
 {id:'s1',side:'staff',branch:'north',text:'We are here'},
 {id:'m2',side:'member',branch:'south',text:'Another branch'},
];

test('staff alerts only on new messages in the authorized active branch',()=>{
 assert.deepEqual(unseenIncomingMessages(new Set(['m1']),messages,'staff','north').map(x=>x.id),[]);
 assert.deepEqual(unseenIncomingMessages(new Set(),messages,'staff','north').map(x=>x.id),['m1']);
});

test('member alerts only on new staff replies and ignores its own messages',()=>{
 assert.deepEqual(unseenIncomingMessages(new Set(),messages,'member','north').map(x=>x.id),['s1']);
});

test('notification text is compact and whitespace-normalized',()=>{
 assert.equal(messageNotificationBody('  Hello\n world  '),'Hello world');
 assert.equal(messageNotificationBody('123456',4),'123…');
});

test('notification clicks restore the right same-origin app and reject arbitrary routes',()=>{
 const worker=readFileSync(new URL('../public/member-sw.js',import.meta.url),'utf8');
 assert.match(worker,/\['\/member','\/clubs'\]\.includes\(requested\.pathname\)/);
 assert.match(worker,/current\.origin===target\.origin/);
 assert.match(worker,/event\.notification\.data\?\.url/);
});
