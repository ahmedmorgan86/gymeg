import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sameOrigin,requestClientIp} from '../app/lib/request-origin.ts';

test('Origin checks never trust forwarded host/proto headers',()=>{
 const previous=process.env.GYMEG_TRUSTED_ORIGINS;
 try{
  delete process.env.GYMEG_TRUSTED_ORIGINS;
  const request=new Request('https://gym.example/api/workspace',{method:'POST',headers:{origin:'https://evil.test','x-forwarded-host':'gym.example','x-forwarded-proto':'https','host':'gym.example'}});
  assert.equal(sameOrigin(request),false,'spoofed forwarded headers must not satisfy CSRF');
  assert.equal(sameOrigin(new Request('https://gym.example/api/workspace',{method:'POST'})),false,'missing Origin is rejected');
  assert.equal(sameOrigin(new Request('https://gym.example/api/workspace',{method:'POST',headers:{origin:'null'}})),false);
  assert.equal(sameOrigin(new Request('https://gym.example/api/workspace',{method:'POST',headers:{origin:'https://gym.example'}})),true);
  process.env.GYMEG_TRUSTED_ORIGINS='https://app.example, https://admin.example';
  assert.equal(sameOrigin(new Request('https://gym.example/api/workspace',{method:'POST',headers:{origin:'https://app.example'}})),true);
  assert.equal(sameOrigin(new Request('https://gym.example/api/workspace',{method:'POST',headers:{origin:'https://app.example.evil.test'}})),false);
 }finally{if(previous===undefined)delete process.env.GYMEG_TRUSTED_ORIGINS;else process.env.GYMEG_TRUSTED_ORIGINS=previous;}
});

test('Rate-limit client IP ignores rotatable headers unless proxy trust is explicitly enabled',()=>{
 const previous=process.env.GYMEG_TRUST_PROXY_IP;
 try{
  delete process.env.GYMEG_TRUST_PROXY_IP;
  const headers={'x-vercel-forwarded-for':'1.2.3.4','x-forwarded-for':'5.6.7.8'};
  assert.equal(requestClientIp(new Request('https://gym.example/api/member-session',{headers})),'unknown');
  process.env.GYMEG_TRUST_PROXY_IP='1';
  assert.equal(requestClientIp(new Request('https://gym.example/api/member-session',{headers})),'1.2.3.4');
  assert.equal(requestClientIp(new Request('https://gym.example/api/member-session',{headers:{'x-forwarded-for':'9.9.9.9, 8.8.8.8'}})),'9.9.9.9');
  assert.equal(requestClientIp(new Request('https://gym.example/api/member-session',{headers:{'x-forwarded-for':'not-an-ip<script>'}})),'unknown');
 }finally{if(previous===undefined)delete process.env.GYMEG_TRUST_PROXY_IP;else process.env.GYMEG_TRUST_PROXY_IP=previous;}
});
