import release from '../../../public/downloads/support-android.json';
import { mobileDownloadResponse } from '../../lib/mobile-download';
export function GET(request:Request){return mobileDownloadResponse(request,release.url,'/support-login');}
