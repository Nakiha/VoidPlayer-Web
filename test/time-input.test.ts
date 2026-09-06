import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTimeInput} from '../src/time-input.ts';
test('inline time accepts seconds and timecodes; offset defaults to signed milliseconds',()=>{
  for(const s of ['3.3','00:03.300','3.3s','3300ms','3300 ms']) assert.equal(parseTimeInput(s),3300000);
  assert.equal(parseTimeInput('1:02:03.004'),3723004000);
  assert.equal(parseTimeInput('03:00'),180000000);
  assert.equal(parseTimeInput('-3.3','ms',true),-3300);
  assert.equal(parseTimeInput('+00:03.300','ms',true),3300000);
  assert.equal(parseTimeInput('0.000001'),1);
  for(const s of ['', '3abc','00:63.1','1:99:00','-1','Infinity','1e3','00:03s','999999999999999999'])assert.throws(()=>parseTimeInput(s));
});
