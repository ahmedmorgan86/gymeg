import {Suspense} from 'react';
import ActionHandler from './handler';
export default function AuthAction(){return <Suspense fallback={null}><ActionHandler/></Suspense>;}
