import type { Metadata,Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./gymeg-design.css";
export const dynamic="force-dynamic";
export const metadata:Metadata={applicationName:"GymEG",appleWebApp:{capable:true,title:"GymEG",statusBarStyle:"black-translucent"},robots:{index:false,follow:false},verification:{google:process.env.GOOGLE_SITE_VERIFICATION,yandex:process.env.YANDEX_SITE_VERIFICATION,other:{...(process.env.BING_SITE_VERIFICATION?{"msvalidate.01":process.env.BING_SITE_VERIFICATION}:{})}},title:"GymEG — YOUR GYM. ONE SYSTEM.",description:"مساحة ناديك لإدارة الأعضاء والحضور والتجديد والتحصيل، مع GymEG Pulse.",manifest:"/manifest.webmanifest",icons:{icon:[{url:"/favicon.ico",sizes:"any"},{url:"/favicon.svg?v=20261029-gymeg-r2",type:"image/svg+xml"}],apple:"/icons/icon-180.png?v=20261029-gymeg-r2"}};
export const viewport:Viewport={themeColor:"#7C3AED"};
export default async function RootLayout({children}:Readonly<{children:React.ReactNode}>){await headers();return <html lang="ar" dir="rtl"><body>{children}</body></html>;}
