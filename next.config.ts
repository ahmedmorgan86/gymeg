import type {NextConfig} from 'next';
import {join} from 'node:path';
const securityHeaders=[
 {key:'X-Content-Type-Options',value:'nosniff'},
 {key:'X-Frame-Options',value:'DENY'},
 {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
 {key:'Permissions-Policy',value:'camera=(self), microphone=(self), geolocation=(), payment=()'},
 {key:'Strict-Transport-Security',value:'max-age=63072000; includeSubDomains; preload'}
];
const config:NextConfig={output:'standalone',images:{dangerouslyAllowSVG:true,contentDispositionType:'inline',contentSecurityPolicy:"default-src 'none'; style-src 'unsafe-inline'; sandbox;",localPatterns:[{pathname:'/images/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261030-role-icons'},{pathname:'/**',search:''},{pathname:'/images/**',search:'?v=20261027'},{pathname:'/images/**',search:'?v=20261028-gymeg'},{pathname:'/images/**',search:'?v=20261029-gymeg'},{pathname:'/icons/**',search:'?v=20261027'},{pathname:'/icons/**',search:'?v=20261028-gymeg'},{pathname:'/icons/**',search:'?v=20261029-gymeg'}]},async headers(){return[{source:'/:path*',headers:securityHeaders},{source:'/downloads/:file*.apk',headers:[{key:'Content-Type',value:'application/vnd.android.package-archive'},{key:'Content-Disposition',value:'attachment'}]}];},serverExternalPackages:['pg'],poweredByHeader:false,outputFileTracingRoot:process.cwd(),outputFileTracingIncludes:{'/*':['./certs/supabase-ca.crt','./public/icons/icon-512.png']},webpack(config){
  // Human's node export otherwise pulls native TensorFlow into the SSR build.
  // Camera inference is loaded only on demand in the client component.
  config.resolve.alias={...config.resolve.alias,'@vladmandic/human$':join(process.cwd(),'node_modules/@vladmandic/human/dist/human.esm.js')};
  return config;
}};
export default config;
