import React from 'react';
export default function Image(p:any){const {src,alt,width,height,className,style}=p;return <img src={typeof src==='string'?src:''} alt={alt} width={width} height={height} className={className} style={style}/>;}
